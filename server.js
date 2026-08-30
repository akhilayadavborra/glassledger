require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---- ledger storage ----
const LEDGER_FILE = path.join(__dirname, 'ledger.json');

function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return { totalSettled: 0, transactions: [] };
  return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
}
function writeLedger(data) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(data, null, 2));
}

// ---- vendor data ----
const vendors = [
  { id: 'vendor_a', name: 'Vendor A — CopperCo', cost: 4000, deliveryDays: 5 },
  { id: 'vendor_b', name: 'Vendor B — FastWire Supplies', cost: 4300, deliveryDays: 1 },
  { id: 'vendor_c', name: 'Vendor C — BudgetMetals', cost: 3700, deliveryDays: 7 }
];
const DOWNTIME_LOSS_PER_DAY = 1500;
const APPROVAL_THRESHOLD = 10000;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'GlassLedger backend is running' });
});

app.get('/api/vendors', (req, res) => {
  res.json({ vendors, downtimeLossPerDay: DOWNTIME_LOSS_PER_DAY });
});

app.get('/api/ledger', (req, res) => {
  res.json(readLedger());
});

app.post('/api/decide', async (req, res) => {
  try {
    const systemPrompt = `You are an autonomous procurement agent. You will be given a list of vendors with cost and delivery days, plus a daily downtime loss figure.
Compare vendors on total cost vs. speed vs. downtime risk, and choose the best one.
Respond ONLY with valid JSON in this exact shape, no markdown, no extra text:
{"reasoning": ["[Agent]: short reasoning line 1", "[Agent]: short reasoning line 2", "[Agent]: short reasoning line 3"], "decision": "vendor_id_here"}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ vendors, downtimeLossPerDay: DOWNTIME_LOSS_PER_DAY }) }
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
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error('AI returned invalid JSON: ' + raw);
    }

    const chosenVendor = vendors.find(v => v.id === parsed.decision);
    if (!chosenVendor) {
      throw new Error(`AI chose an unknown vendor: ${parsed.decision}`);
    }

    const requiresApproval = chosenVendor.cost > APPROVAL_THRESHOLD;

    res.json({
      reasoning: parsed.reasoning,
      decision: chosenVendor,
      requiresApproval
    });

  } catch (err) {
    console.error('Decision engine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { vendorId } = req.body;
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) {
      return res.status(400).json({ error: 'Unknown vendor' });
    }

    const order = await razorpay.orders.create({
      amount: vendor.cost * 100,
      currency: 'INR',
      receipt: `receipt_${vendor.id}_${Date.now()}`,
      notes: { vendor: vendor.name }
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      vendorName: vendor.name
    });
  } catch (err) {
    console.error('Order creation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/verify-payment', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, vendor } = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error('Payment signature verification failed');
      return res.status(400).json({ verified: false, error: 'Signature mismatch' });
    }

    const ledger = readLedger();
    ledger.totalSettled += vendor.cost;
    ledger.transactions.push({
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: vendor.cost,
      vendor: vendor.name,
      timestamp: new Date().toISOString()
    });
    writeLedger(ledger);

    console.log(`✅ Payment verified and reconciled: ₹${vendor.cost}`);
    res.json({ verified: true, ledgerTotal: ledger.totalSettled });

  } catch (err) {
    console.error('Verification error:', err.message);
    res.status(500).json({ verified: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassLedger server running on http://localhost:${PORT}`);
});