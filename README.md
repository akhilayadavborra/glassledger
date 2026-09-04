# GlassLedger

**Every other AI tells you what to buy. GlassLedger buys it.**

Built for the Razorpay AI Buildathon 2026 — AI Growth & Agentic Commerce track.

GlassLedger is an autonomous procurement agent that closes the entire loop — not just the recommendation, but the actual, real, settled payment. Most "AI procurement" tools stop at telling a human what to buy and hand off checkout to a person or a separate finance system. GlassLedger detects a shortage, reasons through vendors out loud, checks its own spending policy, and — within a governed limit — pays for it, with every decision auditable before the money moves.

Live demo: [glassledger.onrender.com](https://glassledger.onrender.com)
Repo: [github.com/akhilayadavborra/glassledger](https://github.com/akhilayadavborra/glassledger)

---

## The core loop

```
Inventory threshold crossed
        │
        ▼
   AI vendor decision  ──── Groq (openai/gpt-oss-120b) compares vendors on
        │                   cost, delivery speed, and downtime-loss risk
        ▼
   Policy engine       ──── server-side, multi-rule, cannot be overridden
        │                   by the AI's own output
        ▼
  Auto-execute  OR  Human approval
        │
        ▼
   Purchase order created
        │
        ▼
   Razorpay order + Checkout
        │
        ▼
   Server-side signature verification
        │
        ▼
   Ledger reconciled  →  Receipt generated  →  Audit event recorded
```

Every step is linked by ID (inventory event → procurement job → PO → Razorpay order → payment → receipt → ledger entry), and the whole chain is walkable from any record in the UI.

---

## Why this exists

Corporate procurement has three specific failure points:

1. **The Inventory Gap** — someone has to notice stock is low before anything happens.
2. **The Naming Crisis** — the same physical product gets listed under wildly inconsistent names across vendors, so simple string-matching breaks.
3. **The Checkout Friction** — even after a decision is made, a human still has to open a tab, fill out a PO, wait for sign-off, and pay by hand.

GlassLedger closes all three: continuous monitoring instead of manual checking, an LLM-based semantic catalog matcher instead of exact-string lookups, and real payment execution instead of a handoff link.

---

## Architecture

```
Browser (splash → landing → auth → dashboard, single-page app)
        │
        ▼
Express backend (server.js)
        │
        ├── /api/vendors               → vendor dataset + eligibility filtering
        ├── /api/decide                → Groq call → decision + reasoning + policy check
        ├── /api/decide-fallback       → deterministic path if Groq fails (see below)
        ├── /api/create-order          → Razorpay order (idempotency-protected)
        ├── /api/verify-payment        → server-side signature verification
        ├── /api/audit-decision        → human approve/reject on gated orders
        ├── /api/record-vendor-failure → failover simulation entry point
        ├── /api/ledger                → running settlement totals + history
        ├── /api/metrics               → real business-impact KPIs (no fabricated numbers)
        ├── /api/audit-log             → full event stream for the Activity page
        ├── /api/ask                   → natural-language Q&A over real ledger data
        └── /api/match-catalog         → semantic vendor-name matching
        │
        ▼
Razorpay (test mode) ←→ Groq (reasoning)
        │
        ▼
Firebase Authentication (session, identity)
```

**Storage:** JSON files (`jobs.json`, `ledger.json`) for the buildathon. Deliberately kept swappable — all reads/writes go through a small number of functions (`readJobs`/`writeJobs`/`readLedger`), so migrating to Postgres later doesn't require touching route logic.

**Frontend:** vanilla HTML/CSS/JS, no framework. A single `dashboard.html` renders 15 views client-side (Overview, Inventory, Requests, Purchase Orders, History, AI Agent, Vendors, Insights, Payments, Approvals, Ledger, Analytics, Documents, Activity, Settings) plus hash-based deep links (`#/vendor/:id`, `#/procurement/:id`, etc.) so individual records are shareable and bookmarkable.

---

## The policy engine — backend is the financial authority

This is the part that matters most: **the AI never authorizes money movement.** Groq recommends a vendor; a separate, deterministic, server-side policy engine decides whether that recommendation can execute automatically or needs a human.

Three rules, evaluated on every decision, all server-side:

| Rule | Limit |
|---|---|
| `cap_per_order` | Single order ≤ ₹10,000 |
| `category_cap_monthly` | Category spend ≤ ₹50,000/month |
| `cumulative_spend_day` | Total daily procurement ≤ ₹25,000/day |

If any rule fires, the order freezes in an Approval Center showing the exact rule name and the real numbers that triggered it — not a generic "needs approval" message. The frontend only *displays* this result; it cannot compute or override it.

**AI failure never authorizes payment.** If Groq times out, errors, or returns invalid data, the job falls back to `/api/decide-fallback` — a deterministic, non-LLM vendor selection that is *always* routed to human approval regardless of amount, specifically because a human should review anything the AI didn't actually reason through.

**Payment settlement is gated the same way.** The frontend sends `razorpay_payment_id`, `razorpay_order_id`, and `razorpay_signature` to the backend; the backend verifies the HMAC signature using the Razorpay secret (server-side only, never in frontend code). Only after that verification succeeds does the ledger update and a receipt generate. A failed or forged signature leaves the ledger untouched.

**Duplicate protection.** Every inventory event has a unique ID that maps to exactly one procurement job. Retrying a request reuses the existing job instead of creating a second PO or a second charge.

---

## Vendor failover

Vendor unavailability is simulated and fed into the *real* decision pipeline, not a separate demo path: a failure is recorded → the vendor is excluded → remaining eligible vendors are re-evaluated → a new vendor is selected → policy is re-checked. A dedicated `vendor_failover` audit event captures the whole transition, e.g.:

> *Vendor B — FastWire Supplies unavailable → re-evaluated → Vendor A — CopperCo selected*

---

## What broke, and how it was fixed

Real problems hit during the build — documenting them because the fixes say more than the feature list does.

- **Groq deprecated the initial model (`llama-3.3-70b-versatile`) mid-build**, returning a 404 with no warning. Fixed by checking Groq's current model docs and switching to `openai/gpt-oss-120b`.
- **Test-mode card payments were rejected** ("international cards are not supported") even with documented test card numbers — traced to account-level restrictions on a new Razorpay account. Fixed by switching test flows to Netbanking's mock success/failure screen.
- **Webhook-based reconciliation was blocked** by Razorpay's KYC-first onboarding flow, which redirected away from webhook settings before business verification completed. Rather than wait on account verification, reconciliation moved to client-side signature verification using the values Checkout's own success handler returns — a standard, documented Razorpay pattern that doesn't depend on a publicly reachable webhook URL.
- **A missing auth guard** meant the dashboard was reachable without logging in. Fixed with a Firebase `onAuthStateChanged` check that redirects unauthenticated visitors.
- **`orders.create()` crashed with `cb is not a function`** during a later security pass, when an idempotency key was added as a second argument (`{ headers: {...} }`) to the Razorpay SDK call. Tracing it into the installed SDK's actual source showed `orders.create(params, callback)` only accepts a callback function as the second argument, or nothing — never an options object. Fixed by moving the idempotency key into the request's `notes` field instead, where the real duplicate-protection already lived independently (a check on `job.orderId` before ever calling Razorpay).
- **The same pass revealed a second, hidden bug**: the Razorpay SDK throws plain `{statusCode, error}` objects on failure, not real `Error` instances — so `catch (err) { ... err.message }` was silently swallowing every real error into an empty `{}` response. Fixed by reading `err.error.description` instead, so failures are now diagnosable instead of invisible.

---

## Tech stack

- **Backend:** Node.js, Express 5, Helmet
- **Frontend:** Vanilla HTML/CSS/JavaScript (no framework, no build step)
- **Authentication:** Firebase Authentication (email/password, Google sign-in, password reset, session persistence)
- **AI reasoning:** Groq API (`openai/gpt-oss-120b`)
- **Payments:** Razorpay Orders API + Checkout.js (test mode)
- **Storage:** JSON-based (swappable — see production roadmap)
- **PDF generation:** jsPDF (purchase orders, receipts)

Every service used sits on a free tier — this project runs at ₹0 infrastructure cost.

---

## Production roadmap

What this would need to go from a working buildathon submission to a production system — deliberately *not* built now, since it wouldn't have improved the demo, only the resume:

- **PostgreSQL** in place of JSON file storage — the storage-access layer is already isolated to make this a contained change
- **Webhook-based reconciliation** as a durable backup to client-side signature verification, once account KYC clears
- **Background job queue** (e.g. BullMQ) for retries instead of synchronous request handling
- **Multi-tenancy** — real companies/users instead of one shared demo dataset
- **Structured logging and monitoring** (e.g. Sentry, basic metrics/alerting)
- **Rate limiting and stronger secrets management**

---

## Running locally

```bash
npm install
cp .env.example .env   # fill in RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, GROQ_API_KEY
npm start
```

Visit `http://localhost:3000`.
