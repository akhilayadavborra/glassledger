require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const Razorpay = require('razorpay');

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false, originAgentCluster: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------------------------------------------------------------------------
// Storage helpers
// Prototype storage note: this project uses flat JSON files for the
// buildathon demo. In production, GlassLedger would use PostgreSQL with
// proper tables for jobs, transactions, audit events, and vendor data,
// plus background workers for retries and webhook processing. See
// PRODUCTION_ARCHITECTURE.md for the full scaling plan.
// ---------------------------------------------------------------------------
const LEDGER_FILE = path.join(__dirname, 'ledger.json');
function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return { totalSettled: 0, totalSaved: 0, transactions: [] };
  const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
  if (typeof data.totalSaved !== 'number') data.totalSaved = 0;
  return data;
}
function writeLedger(data) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(data, null, 2));
}

const JOBS_FILE = path.join(__dirname, 'jobs.json');
function readJobs() {
  if (!fs.existsSync(JOBS_FILE)) return { jobs: [] };
  return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
}
function writeJobs(data) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
}
function findJob(jobsData, jobId) {
  return jobsData.jobs.find(j => j.jobId === jobId);
}
function findJobByEvent(jobsData, inventoryEventId) {
  return jobsData.jobs.find(j => j.inventoryEventId === inventoryEventId);
}
function addEvent(job, event, status, meta = {}) {
  job.events.push({ event, status, meta, timestamp: new Date().toISOString() });
}
function nextPoNumber(jobsData) {
  const seq = jobsData.jobs.filter(j => j.poNumber).length + 1;
  return `PO-2026-${String(seq).padStart(6, '0')}`;
}
function nextReceiptNumber(jobsData) {
  const seq = jobsData.jobs.filter(j => j.receiptNumber).length + 1;
  return `GL-RCP-2026-${String(seq).padStart(6, '0')}`;
}

// Human-readable, auditable activity log. Deliberately does NOT surface raw
// model chain-of-thought — only structured, factual events plus one short
// AI-provided rationale line, clearly labeled as such.
function describeEvent(e) {
  const m = e.meta || {};
  switch (e.event) {
    case 'inventory_threshold_crossed': return `Inventory threshold crossed — procurement request opened`;
    case 'vendors_analyzed': return `Vendor eligibility checked — ${m.eligibleCount} of ${m.totalCount} vendors eligible`;
    case 'vendor_eliminated': return `${m.vendorName} eliminated — ${m.reason}`;
    case 'vendor_selected': return `${m.vendorName} selected — total expected cost ₹${m.totalExpectedCost}`;
    case 'agent_rationale': return `Agent rationale: ${m.text}`;
    case 'guardrail_passed': return `Spending policy passed automatically (₹${m.payableAmount} ≤ ₹${m.threshold})`;
    case 'guardrail_blocked': return `Spending policy requires human approval — ${m.firedRules && m.firedRules.length ? m.firedRules.join(' + ') : `₹${m.payableAmount} exceeds ₹${m.threshold}`}`;
    case 'approval_requested': return `Human approval requested`;
    case 'approval_received': return `Approval ${m.decision} by user`;
    case 'vendor_failure': return `${m.vendorName} failure recorded — ${m.reason}`;
    case 'vendor_failover': return `${(m.failedVendorNames||[]).join(', ')} unavailable → re-evaluated → ${m.selectedVendorName} selected`;
    case 'ai_fallback_engaged': return `AI reasoning unavailable — deterministic safe fallback engaged`;
    case 'purchase_order_created': return `Purchase order ${m.poNumber} created`;
    case 'razorpay_order_created': return `Razorpay order created (${m.orderId})`;
    case 'payment_received': return `Payment received (${m.paymentId})`;
    case 'signature_verified': return m.status === 'failed' ? `Payment signature verification FAILED` : `Payment signature verified`;
    case 'ledger_reconciled': return `Ledger reconciled — ₹${m.amount} settled, ₹${m.savings} saved`;
    case 'receipt_generated': return `Receipt ${m.receiptNumber} generated`;
    case 'duplicate_blocked': return `Duplicate procurement attempt blocked — job already ${m.status}`;
    default: return e.event;
  }
}
function toActivityLog(job) {
  return job.events.map(describeEvent);
}

// ---------------------------------------------------------------------------
// Vendor data and deterministic business logic
// cost = purchase price only. shippingCost is separate. Both are REAL money
// charged via Razorpay. downtimeCost and riskCost are internal
// decision-support figures used only for comparison, never charged.
// ---------------------------------------------------------------------------
const vendors = [
  { id: 'vendor_a', name: 'Vendor A — CopperCo', category: 'Raw Materials', cost: 4000, shippingCost: 150, deliveryDays: 5, available: true, quantityAvailable: 600, compatible: true, reliabilityScore: 0.92 },
  { id: 'vendor_b', name: 'Vendor B — FastWire Supplies', category: 'Raw Materials', cost: 4300, shippingCost: 100, deliveryDays: 1, available: true, quantityAvailable: 550, compatible: true, reliabilityScore: 0.88 },
  { id: 'vendor_c', name: 'Vendor C — BudgetMetals', category: 'Raw Materials', cost: 3700, shippingCost: 200, deliveryDays: 7, available: true, quantityAvailable: 700, compatible: true, reliabilityScore: 0.95 },
  { id: 'vendor_d', name: 'Vendor D — QuickMetal Traders', category: 'Raw Materials', cost: 3500, shippingCost: 120, deliveryDays: 2, available: false, quantityAvailable: 50, compatible: true, reliabilityScore: 0.60 }
];

const REQUIRED_QUANTITY = 200;
const MAX_DELIVERY_DAYS = 8;
const DOWNTIME_LOSS_PER_DAY = 1500;
const RISK_WEIGHT = 0.5;
const APPROVAL_THRESHOLD = 10000; // applies to real payable amount only
const CATEGORY_MONTHLY_CAP = 50000;
const DAILY_SPEND_CAP = 25000;
const ACTIVE_SPEND_STATUSES = ['guardrail_passed', 'awaiting_approval', 'approved', 'po_created', 'payment_processing', 'reconciled'];

// Multi-dimensional policy engine — every rule is evaluated server-side.
// AI never sees or influences this; it only recommends a vendor. Returns a
// structured result so the exact fired rule(s) can be shown to a human.
function evaluatePolicy(jobsData, currentJob, breakdown, vendor) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  const otherJobs = jobsData.jobs.filter(j => j.jobId !== currentJob.jobId && ACTIVE_SPEND_STATUSES.includes(j.status));

  const categorySpendThisMonth = otherJobs
    .filter(j => j.events[0] && j.events[0].timestamp.slice(0, 7) === month)
    .filter(j => { const v = vendors.find(v => v.id === j.vendorId); return v && v.category === vendor.category; })
    .reduce((sum, j) => sum + (j.payableAmount || 0), 0);
  const categoryProjected = categorySpendThisMonth + breakdown.payableAmount;

  const spendToday = otherJobs
    .filter(j => j.events[0] && j.events[0].timestamp.slice(0, 10) === today)
    .reduce((sum, j) => sum + (j.payableAmount || 0), 0);
  const dailyProjected = spendToday + breakdown.payableAmount;

  const rules = [
    {
      rule: 'cap_per_order',
      description: `Single order must not exceed ₹${APPROVAL_THRESHOLD.toLocaleString('en-IN')}`,
      passed: breakdown.payableAmount <= APPROVAL_THRESHOLD,
      detail: `This order is ₹${breakdown.payableAmount.toLocaleString('en-IN')}, limit is ₹${APPROVAL_THRESHOLD.toLocaleString('en-IN')}`
    },
    {
      rule: 'category_cap_monthly',
      description: `${vendor.category} spend must not exceed ₹${CATEGORY_MONTHLY_CAP.toLocaleString('en-IN')} per month`,
      passed: categoryProjected <= CATEGORY_MONTHLY_CAP,
      detail: `${vendor.category} spend this month would reach ₹${categoryProjected.toLocaleString('en-IN')} (limit ₹${CATEGORY_MONTHLY_CAP.toLocaleString('en-IN')})`
    },
    {
      rule: 'cumulative_spend_day',
      description: `Total procurement spend must not exceed ₹${DAILY_SPEND_CAP.toLocaleString('en-IN')} per day`,
      passed: dailyProjected <= DAILY_SPEND_CAP,
      detail: `Today's cumulative spend would reach ₹${dailyProjected.toLocaleString('en-IN')} (limit ₹${DAILY_SPEND_CAP.toLocaleString('en-IN')})`
    }
  ];

  const firedRules = rules.filter(r => !r.passed);
  const action = firedRules.length ? 'REQUIRES_APPROVAL' : 'AUTO_EXECUTE';
  const explanation = firedRules.length
    ? `Requires human approval — policy rule(s) fired: ${firedRules.map(r => r.rule).join(', ')}.`
    : 'All policy rules passed — eligible for automatic execution.';

  return { action, rules, firedRules, explanation };
}

function checkEligibility(vendor) {
  const reasons = [];
  if (!vendor.available) reasons.push('currently unavailable');
  if (vendor.quantityAvailable < REQUIRED_QUANTITY) reasons.push('insufficient stock');
  if (vendor.deliveryDays > MAX_DELIVERY_DAYS) reasons.push('delivery exceeds deadline');
  if (!vendor.compatible) reasons.push('incompatible with requirement');
  return { eligible: reasons.length === 0, reasons };
}

// Total Expected Procurement Cost: purchase price + shipping + downtime + risk.
// payableAmount (price + shipping) is what's actually charged via Razorpay.
function costBreakdown(vendor) {
  const purchasePrice = vendor.cost;
  const shippingCost = vendor.shippingCost;
  const downtimeCost = vendor.deliveryDays * DOWNTIME_LOSS_PER_DAY;
  const payableAmount = purchasePrice + shippingCost;
  const riskCost = Math.round((payableAmount + downtimeCost) * (1 - vendor.reliabilityScore) * RISK_WEIGHT);
  const totalExpectedCost = payableAmount + downtimeCost + riskCost;
  return {
    vendorId: vendor.id, vendorName: vendor.name,
    purchasePrice, shippingCost, downtimeCost, riskCost, payableAmount, totalExpectedCost,
    deliveryDays: vendor.deliveryDays, reliabilityScore: vendor.reliabilityScore
  };
}

// ---------------------------------------------------------------------------
// AI call — strict validation + retry. This function ONLY ever returns a
// proposed decision. It has no access to payment or ledger code, so an AI
// failure structurally cannot cause an unauthorized financial transaction.
// ---------------------------------------------------------------------------
async function callGroqForDecision(vendorBreakdowns) {
  const systemPrompt = `You are an autonomous procurement agent. You are given ALREADY-ELIGIBLE vendors with a pre-computed Total Expected Procurement Cost breakdown (purchase price + shipping + downtime cost + risk cost). Choose the vendor with the best overall value — the cheapest purchase price is NOT necessarily the best choice if its total expected cost is higher. Explain the trade-off in plain terms.
Respond ONLY with valid JSON, no markdown:
{"reasoning": ["short reasoning line 1", "short reasoning line 2"], "decision": "vendor_id_here"}`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ vendors: vendorBreakdowns }) }
      ],
      temperature: 0.3
    })
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq API error: ${groqRes.status} ${errText}`);
  }
  const data = await groqRes.json();
  const raw = data.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('AI returned malformed JSON'); }
  if (!Array.isArray(parsed.reasoning) || parsed.reasoning.length === 0) throw new Error('AI response missing valid reasoning array');
  if (typeof parsed.decision !== 'string' || !parsed.decision) throw new Error('AI response missing valid decision');
  return parsed;
}

async function callGroqWithRetry(vendorBreakdowns, maxAttempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await callGroqForDecision(vendorBreakdowns); }
    catch (err) {
      lastError = err;
      console.error(`Groq attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Routes — core data
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'GlassLedger backend is running' }));
app.get('/api/vendors', (req, res) => res.json({ vendors, downtimeLossPerDay: DOWNTIME_LOSS_PER_DAY }));
app.get('/api/ledger', (req, res) => res.json(readLedger()));

app.get('/api/vendor-performance', (req, res) => {
  const ledger = readLedger();
  const performance = vendors.map(v => {
    const txns = ledger.transactions.filter(t => t.vendor === v.name);
    const totalSpend = txns.reduce((sum, t) => sum + t.amount, 0);
    return {
      vendorId: v.id, name: v.name, category: v.category, status: v.available ? 'Active' : 'Unavailable',
      reliabilityScore: v.reliabilityScore, averageDeliveryDays: v.deliveryDays,
      orderCount: txns.length, totalSpend, onTimeRate: Math.round(v.reliabilityScore * 100)
    };
  });
  res.json({ performance });
});

// ---------------------------------------------------------------------------
// Procurement jobs — list + detail (for Procurement / Purchase Orders / Documents pages)
// ---------------------------------------------------------------------------
app.get('/api/jobs', (req, res) => {
  const jobsData = readJobs();
  const summarized = jobsData.jobs.map(j => ({
    jobId: j.jobId, poNumber: j.poNumber, receiptNumber: j.receiptNumber,
    vendorId: j.vendorId, vendorName: j.vendorName, payableAmount: j.payableAmount, status: j.status,
    policyResult: j.policyResult || null,
    createdAt: j.events[0] ? j.events[0].timestamp : null,
    updatedAt: j.events.length ? j.events[j.events.length - 1].timestamp : null
  }));
  res.json({ jobs: summarized.reverse() });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const jobsData = readJobs();
  const job = findJob(jobsData, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job, activityLog: toActivityLog(job) });
});

app.get('/api/operations-summary', (req, res) => {
  const jobsData = readJobs();
  const ledger = readLedger();
  const totalDecisions = jobsData.jobs.length;
  const successfulProcurements = jobsData.jobs.filter(j => j.status === 'reconciled').length;
  const pendingApprovals = jobsData.jobs.filter(j => j.status === 'awaiting_approval').length;
  const activePOs = jobsData.jobs.filter(j => j.poNumber && j.status !== 'reconciled' && j.status !== 'rejected').length;
  let vendorFailures = 0, approvalsGiven = 0;
  jobsData.jobs.forEach(job => job.events.forEach(e => {
    if (e.event === 'vendor_failure') vendorFailures++;
    if (e.event === 'approval_received' && e.meta.decision === 'approved') approvalsGiven++;
  }));
  res.json({
    totalDecisions, successfulProcurements, pendingApprovals, activePOs, vendorFailures, approvalsGiven,
    totalAmountProcessed: ledger.totalSettled, estimatedSavings: ledger.totalSaved,
    transactionCount: ledger.transactions.length
  });
});

app.get('/api/metrics', (req, res) => {
  const jobsData = readJobs();
  const ledger = readLedger();
  const jobs = jobsData.jobs;

  const decidedJobs = jobs.filter(j => j.vendorId); // reached a vendor decision
  const autoExecuted = decidedJobs.filter(j => j.policyResult ? j.policyResult.action === 'AUTO_EXECUTE' : j.status === 'guardrail_passed').length;
  const humanInterventions = decidedJobs.filter(j => j.policyResult ? j.policyResult.action === 'REQUIRES_APPROVAL' : j.status === 'awaiting_approval' || j.events.some(e => e.event === 'approval_requested')).length;
  const straightThroughPct = decidedJobs.length ? Math.round((autoExecuted / decidedJobs.length) * 100) : 0;

  const decisionTimes = [];
  jobs.forEach(j => {
    const start = j.events.find(e => e.event === 'inventory_threshold_crossed');
    const end = j.events.find(e => e.event === 'vendor_selected');
    if (start && end) decisionTimes.push((new Date(end.timestamp) - new Date(start.timestamp)) / 1000);
  });
  const avgDecisionSeconds = decisionTimes.length ? Math.round(decisionTimes.reduce((a, b) => a + b, 0) / decisionTimes.length) : null;
  const sortedTimes = [...decisionTimes].sort((a, b) => a - b);
  const medianDecisionSeconds = sortedTimes.length ? sortedTimes[Math.floor(sortedTimes.length / 2)] : null;

  const jobsWithFailover = jobs.filter(j => j.events.some(e => e.event === 'vendor_failure'));
  const failoverRecovered = jobsWithFailover.filter(j => j.status !== 'failed').length;
  const failoverSuccessRate = jobsWithFailover.length ? Math.round((failoverRecovered / jobsWithFailover.length) * 100) : null;

  res.json({
    estimatedSavings: ledger.totalSaved || 0,
    totalProcessedSpend: ledger.totalSettled || 0,
    straightThroughPct,
    autoExecutedCount: autoExecuted,
    humanInterventions,
    decidedCount: decidedJobs.length,
    avgDecisionSeconds, medianDecisionSeconds,
    vendorFailoverAttempts: jobsWithFailover.length,
    vendorFailoverSuccessRate: failoverSuccessRate,
    transactionCount: ledger.transactions.length
  });
});

app.get('/api/audit-log', (req, res) => {
  const jobsData = readJobs();
  const entries = [];
  jobsData.jobs.forEach(job => {
    job.events.forEach(e => {
      entries.push({
        jobId: job.jobId,
        event: e.event,
        description: describeEvent(e),
        vendorName: job.vendorName,
        amount: job.payableAmount,
        outcome: e.status,
        timestamp: e.timestamp
      });
    });
  });
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ entries });
});

// ---------------------------------------------------------------------------
// Main hybrid decision pipeline
// 1. deterministic eligibility filter  2. deterministic cost breakdown
// 3. AI reasons ONLY over the pre-filtered, pre-costed eligible set
// 4. backend validates AI's choice and computes guardrail + savings itself
// Duplicate prevention: one inventoryEventId maps to one job. If that job is
// already reconciled, no new AI call or procurement happens — the existing
// result is returned instead.
// ---------------------------------------------------------------------------
app.post('/api/decide', async (req, res) => {
  try {
    const { inventoryEventId, excludeVendorIds } = req.body || {};
    if (!inventoryEventId) return res.status(400).json({ error: 'inventoryEventId is required' });
    const excluded = Array.isArray(excludeVendorIds) ? excludeVendorIds : [];

    const jobsData = readJobs();
    let job = findJobByEvent(jobsData, inventoryEventId);

    if (job && job.status === 'reconciled') {
      addEvent(job, 'duplicate_blocked', 'blocked', { status: job.status });
      writeJobs(jobsData);
      return res.json({
        alreadyProcessed: true, jobId: job.jobId, activityLog: toActivityLog(job),
        message: 'This inventory event has already been fully processed — no new procurement will be created.'
      });
    }

    if (!job) {
      job = { jobId: crypto.randomUUID(), inventoryEventId, poNumber: null, receiptNumber: null,
        status: 'analyzing', vendorId: null, vendorName: null, payableAmount: null,
        orderId: null, paymentId: null, events: [] };
      addEvent(job, 'inventory_threshold_crossed', 'ok', {});
      jobsData.jobs.push(job);
    }

    const candidateVendors = vendors.filter(v => !excluded.includes(v.id));
    const eligibleVendors = [];
    candidateVendors.forEach(v => {
      const { eligible, reasons } = checkEligibility(v);
      if (eligible) eligibleVendors.push(v);
      else addEvent(job, 'vendor_eliminated', 'excluded', { vendorId: v.id, vendorName: v.name, reason: reasons.join(', ') });
    });
    addEvent(job, 'vendors_analyzed', 'ok', { eligibleCount: eligibleVendors.length, totalCount: candidateVendors.length });

    if (eligibleVendors.length === 0) {
      job.status = 'failed';
      writeJobs(jobsData);
      return res.status(422).json({ error: 'No vendors meet eligibility requirements', jobId: job.jobId, activityLog: toActivityLog(job) });
    }

    const breakdowns = eligibleVendors.map(costBreakdown);

    let parsed;
    try {
      parsed = await callGroqWithRetry(breakdowns, 2);
    } catch (aiErr) {
      console.error('AI decision failed after retries:', aiErr.message);
      job.status = 'ai_failed';
      writeJobs(jobsData);
      return res.status(503).json({ error: 'AI reasoning unavailable after retries', aiFailure: true, jobId: job.jobId, activityLog: toActivityLog(job) });
    }

    const chosenVendor = eligibleVendors.find(v => v.id === parsed.decision);
    if (!chosenVendor) {
      job.status = 'ai_failed';
      writeJobs(jobsData);
      return res.status(503).json({ error: 'AI selected an invalid vendor', aiFailure: true, jobId: job.jobId, activityLog: toActivityLog(job) });
    }

    const chosenBreakdown = breakdowns.find(b => b.vendorId === chosenVendor.id);
    addEvent(job, 'vendor_selected', 'ok', { vendorId: chosenVendor.id, vendorName: chosenVendor.name, totalExpectedCost: chosenBreakdown.totalExpectedCost });
    if (excluded.length > 0) {
      const failedNames = excluded.map(id => (vendors.find(v => v.id === id) || {}).name || id);
      addEvent(job, 'vendor_failover', 'ok', {
        failedVendorIds: excluded, failedVendorNames: failedNames,
        selectedVendorId: chosenVendor.id, selectedVendorName: chosenVendor.name
      });
    }
    if (parsed.reasoning && parsed.reasoning[0]) {
      addEvent(job, 'agent_rationale', 'info', { text: String(parsed.reasoning[0]).replace('[Agent]:', '').trim() });
    }

    const policyResult = evaluatePolicy(jobsData, job, chosenBreakdown, chosenVendor);
    const requiresApproval = policyResult.action === 'REQUIRES_APPROVAL';
    const approvalReason = requiresApproval ? policyResult.explanation : null;

    if (requiresApproval) {
      addEvent(job, 'guardrail_blocked', 'blocked', { payableAmount: chosenBreakdown.payableAmount, threshold: APPROVAL_THRESHOLD, firedRules: policyResult.firedRules.map(r => r.rule) });
      addEvent(job, 'approval_requested', 'pending', { firedRules: policyResult.firedRules.map(r => r.rule) });
      job.status = 'awaiting_approval';
    } else {
      addEvent(job, 'guardrail_passed', 'ok', { payableAmount: chosenBreakdown.payableAmount, threshold: APPROVAL_THRESHOLD });
      job.status = 'guardrail_passed';
    }

    job.vendorId = chosenVendor.id;
    job.vendorName = chosenVendor.name;
    job.payableAmount = chosenBreakdown.payableAmount;
    job.policyResult = policyResult;
    writeJobs(jobsData);

    const worstTotalCost = Math.max(...breakdowns.map(b => b.totalExpectedCost));
    const savings = Math.max(0, worstTotalCost - chosenBreakdown.totalExpectedCost);

    res.json({
      jobId: job.jobId, inventoryEventId, activityLog: toActivityLog(job),
      decision: chosenVendor, decisionBreakdown: chosenBreakdown, costComparison: breakdowns,
      requiresApproval, approvalReason, policyResult, savings
    });
  } catch (err) {
    console.error('Decision engine error:', err.message);
    res.status(500).json({ error: err.message, aiFailure: true });
  }
});

// Deterministic safe fallback — used only when AI reasoning has already
// failed. No LLM call happens here. ALWAYS requires manual approval
// regardless of amount, since the path it came from already failed once.
app.post('/api/decide-fallback', (req, res) => {
  try {
    const { inventoryEventId, excludeVendorIds } = req.body || {};
    if (!inventoryEventId) return res.status(400).json({ error: 'inventoryEventId is required' });
    const excluded = Array.isArray(excludeVendorIds) ? excludeVendorIds : [];

    const jobsData = readJobs();
    let job = findJobByEvent(jobsData, inventoryEventId);
    if (!job) {
      job = { jobId: crypto.randomUUID(), inventoryEventId, poNumber: null, receiptNumber: null,
        status: 'analyzing', vendorId: null, vendorName: null, payableAmount: null,
        orderId: null, paymentId: null, events: [] };
      addEvent(job, 'inventory_threshold_crossed', 'ok', {});
      jobsData.jobs.push(job);
    }
    addEvent(job, 'ai_fallback_engaged', 'info', {});

    const candidateVendors = vendors.filter(v => !excluded.includes(v.id));
    const eligibleVendors = [];
    candidateVendors.forEach(v => {
      const { eligible, reasons } = checkEligibility(v);
      if (eligible) eligibleVendors.push(v);
      else addEvent(job, 'vendor_eliminated', 'excluded', { vendorId: v.id, vendorName: v.name, reason: reasons.join(', ') });
    });
    addEvent(job, 'vendors_analyzed', 'ok', { eligibleCount: eligibleVendors.length, totalCount: candidateVendors.length });

    if (eligibleVendors.length === 0) {
      job.status = 'failed';
      writeJobs(jobsData);
      return res.status(422).json({ error: 'No vendors meet eligibility requirements', jobId: job.jobId, activityLog: toActivityLog(job) });
    }

    const breakdowns = eligibleVendors.map(costBreakdown);
    const best = breakdowns.reduce((a, b) => (b.totalExpectedCost < a.totalExpectedCost ? b : a));
    const chosenVendor = eligibleVendors.find(v => v.id === best.vendorId);

    addEvent(job, 'vendor_selected', 'ok', { vendorId: chosenVendor.id, vendorName: chosenVendor.name, totalExpectedCost: best.totalExpectedCost });
    if (excluded.length > 0) {
      const failedNames = excluded.map(id => (vendors.find(v => v.id === id) || {}).name || id);
      addEvent(job, 'vendor_failover', 'ok', {
        failedVendorIds: excluded, failedVendorNames: failedNames,
        selectedVendorId: chosenVendor.id, selectedVendorName: chosenVendor.name
      });
    }
    const policyResult = {
      action: 'REQUIRES_APPROVAL',
      rules: [{ rule: 'ai_fallback_review', description: 'Deterministic fallback path always requires human approval', passed: false, detail: 'AI reasoning failed earlier in this job — safe fallback engaged, approval required regardless of amount' }],
      firedRules: [{ rule: 'ai_fallback_review' }],
      explanation: 'Requires human approval — the AI reasoning step failed earlier, so this recommendation came from a safe deterministic fallback, not the AI. Policy requires human review any time the fallback path is used.'
    };
    addEvent(job, 'guardrail_blocked', 'blocked', { payableAmount: best.payableAmount, threshold: APPROVAL_THRESHOLD, firedRules: ['ai_fallback_review'] });
    addEvent(job, 'approval_requested', 'pending', { firedRules: ['ai_fallback_review'] });
    job.status = 'awaiting_approval';
    job.vendorId = chosenVendor.id;
    job.vendorName = chosenVendor.name;
    job.payableAmount = best.payableAmount;
    job.policyResult = policyResult;
    writeJobs(jobsData);

    const worstTotalCost = Math.max(...breakdowns.map(b => b.totalExpectedCost));
    const savings = Math.max(0, worstTotalCost - best.totalExpectedCost);

    res.json({
      jobId: job.jobId, inventoryEventId, activityLog: toActivityLog(job),
      decision: chosenVendor, decisionBreakdown: best, costComparison: breakdowns,
      requiresApproval: true,
      approvalReason: policyResult.explanation,
      policyResult, savings, isFallback: true
    });
  } catch (err) {
    console.error('Fallback decision error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audit-decision', (req, res) => {
  try {
    const { jobId, decision } = req.body;
    if (!jobId || !['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid audit entry' });
    const jobsData = readJobs();
    const job = findJob(jobsData, jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    addEvent(job, 'approval_received', decision, { decision });
    job.status = decision === 'approved' ? 'approved' : 'rejected';
    writeJobs(jobsData);

    console.log(`📋 Job ${jobId}: ${decision.toUpperCase()}`);
    res.json({ ok: true, activityLog: toActivityLog(job) });
  } catch (err) {
    console.error('Audit logging error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/record-vendor-failure', (req, res) => {
  try {
    const { jobId, vendorId, vendorName, reason } = req.body;
    if (!jobId || !vendorId || !vendorName) return res.status(400).json({ error: 'Missing vendor details' });
    const jobsData = readJobs();
    const job = findJob(jobsData, jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    addEvent(job, 'vendor_failure', 'failed', { vendorId, vendorName, reason: reason || 'connection timeout' });
    writeJobs(jobsData);
    console.log(`⚠ Vendor failure recorded on job ${jobId}: ${vendorName}`);
    res.json({ ok: true, activityLog: toActivityLog(job) });
  } catch (err) {
    console.error('Failure logging error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Creates the Razorpay order AND the internal Purchase Order record together.
// Duplicate prevention: if this job already has an order, the existing one
// is returned instead of creating a second one.
app.post('/api/create-order', async (req, res) => {
  try {
    const { jobId } = req.body;
    const jobsData = readJobs();
    const job = findJob(jobsData, jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'rejected') return res.status(403).json({ error: 'This procurement job was rejected — no order can be created' });

    if (job.orderId) {
      return res.json({
        orderId: job.orderId, amount: job.payableAmount * 100, currency: 'INR',
        keyId: process.env.RAZORPAY_KEY_ID, vendorName: job.vendorName, poNumber: job.poNumber, alreadyExists: true
      });
    }

    const vendor = vendors.find(v => v.id === job.vendorId);
    if (!vendor) return res.status(400).json({ error: 'Unknown vendor on job' });

    const breakdown = costBreakdown(vendor);
    const poNumber = nextPoNumber(jobsData);
    addEvent(job, 'purchase_order_created', 'ok', { poNumber });
    job.poNumber = poNumber;

    const idempotencyKey = `job_${jobId}`;
    const order = await razorpay.orders.create({
      amount: breakdown.payableAmount * 100,
      currency: 'INR',
      receipt: `receipt_${jobId}`,
      notes: { vendor: vendor.name, jobId, poNumber, idempotencyKey }
    });

    addEvent(job, 'razorpay_order_created', 'ok', { orderId: order.id });
    job.orderId = order.id;
    job.status = 'order_created';
    writeJobs(jobsData);

    res.json({
      orderId: order.id, amount: order.amount, currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, vendorName: vendor.name, poNumber
    });
  } catch (err) {
    const razorpayMessage = err && err.error && (err.error.description || err.error.reason);
    console.error('Order creation error:', razorpayMessage || err.message || err);
    res.status(500).json({ error: razorpayMessage || err.message || 'Order creation failed' });
  }
});

// Backend verifies the Razorpay signature server-side. Never trusts any
// amount or vendor sent by the client — re-derives everything from the
// job's own recorded vendorId. Ledger is only ever updated below this
// signature check, never before it. Duplicate prevention: if this job is
// already reconciled, returns success without crediting the ledger again.
app.post('/api/verify-payment', (req, res) => {
  try {
    const { jobId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!jobId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: 'Missing required payment details' });
    }

    const jobsData = readJobs();
    const job = findJob(jobsData, jobId);
    if (!job) return res.status(404).json({ verified: false, error: 'Job not found' });

    if (job.status === 'reconciled') {
      const ledger = readLedger();
      return res.json({ verified: true, alreadyProcessed: true, ledgerTotal: ledger.totalSettled, totalSaved: ledger.totalSaved, receiptNumber: job.receiptNumber });
    }

    const vendor = vendors.find(v => v.id === job.vendorId);
    if (!vendor) return res.status(400).json({ verified: false, error: 'Unknown vendor on job' });

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    addEvent(job, 'payment_received', 'ok', { paymentId: razorpay_payment_id });

    if (expectedSignature !== razorpay_signature) {
      addEvent(job, 'signature_verified', 'failed', {});
      job.status = 'payment_failed';
      writeJobs(jobsData);
      console.error(`Payment signature verification failed for job ${jobId}`);
      return res.status(400).json({ verified: false, error: 'Payment could not be verified. The ledger has not been updated.' });
    }
    addEvent(job, 'signature_verified', 'ok', {});

    const breakdown = costBreakdown(vendor);
    const worstTotalCost = Math.max(...vendors.map(v => costBreakdown(v).totalExpectedCost));
    const savings = Math.max(0, worstTotalCost - breakdown.totalExpectedCost);

    const ledger = readLedger();
    ledger.totalSettled += breakdown.payableAmount;
    ledger.totalSaved += savings;
    ledger.transactions.push({
      jobId, poNumber: job.poNumber,
      paymentId: razorpay_payment_id, orderId: razorpay_order_id,
      amount: breakdown.payableAmount, vendor: vendor.name, savings,
      timestamp: new Date().toISOString()
    });
    writeLedger(ledger);
    addEvent(job, 'ledger_reconciled', 'ok', { amount: breakdown.payableAmount, savings });

    const receiptNumber = nextReceiptNumber(jobsData);
    job.receiptNumber = receiptNumber;
    addEvent(job, 'receipt_generated', 'ok', { receiptNumber });

    job.status = 'reconciled';
    job.paymentId = razorpay_payment_id;
    writeJobs(jobsData);

    console.log(`✅ Job ${jobId} reconciled: ₹${breakdown.payableAmount} (saved ₹${savings}), receipt ${receiptNumber}`);
    res.json({
      verified: true, ledgerTotal: ledger.totalSettled, totalSaved: ledger.totalSaved,
      receiptNumber, poNumber: job.poNumber, activityLog: toActivityLog(job)
    });
  } catch (err) {
    console.error('Verification error:', err.message);
    res.status(500).json({ verified: false, error: err.message });
  }
});

app.post('/api/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required' });

    const ledger = readLedger();
    const summary = {
      totalSettled: ledger.totalSettled, totalSaved: ledger.totalSaved,
      transactionCount: ledger.transactions.length, transactions: ledger.transactions.slice(-20)
    };
    const systemPrompt = `You are GlassLedger's analytics assistant. Answer using ONLY this data — never fabricate figures not present here. Be concise, 1-3 sentences, use ₹ for currency.\nData:\n${JSON.stringify(summary)}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }],
        temperature: 0.2
      })
    });
    if (!groqRes.ok) throw new Error(`Groq API error: ${groqRes.status}`);
    const data = await groqRes.json();
    res.json({ answer: data.choices[0].message.content });
  } catch (err) {
    console.error('Ask endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/match-catalog', async (req, res) => {
  try {
    const requiredItem = (req.body && req.body.requiredItem) || '0.5mm Copper Wire';
    const messyCatalogListings = [
      { vendorId: 'vendor_a', listingName: '0.5mm Pure Copper Cord' },
      { vendorId: 'vendor_b', listingName: 'Heavy Duty Copper Wiring 0.5' },
      { vendorId: 'vendor_c', listingName: 'Copper Wire 0.5mm Industrial Grade' },
      { vendorId: 'vendor_d', listingName: 'Aluminum Sheet 2mm' }
    ];
    const systemPrompt = `You are a semantic catalog matcher. Determine which listings refer to the same physical item as the required item, despite different wording. Respond ONLY with valid JSON:\n{"matches": [{"vendorId": "...", "listingName": "...", "isMatch": true or false, "confidence": 0.0 to 1.0}]}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify({ requiredItem, listings: messyCatalogListings }) }],
        temperature: 0.1
      })
    });
    if (!groqRes.ok) throw new Error(`Groq API error: ${groqRes.status}`);
    const data = await groqRes.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    res.json({ requiredItem, matches: parsed.matches });
  } catch (err) {
    console.error('Catalog match error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassLedger server running on http://localhost:${PORT}`);
});
