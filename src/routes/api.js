const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../services/supabaseService');
const { processMessage, processForBusiness } = require('../services/agentCore');

const router = express.Router();

// Public config the landing page needs, like the WhatsApp number to link
// to. Keeping this dynamic (from env) means the site never goes stale
// when the number changes, e.g. moving off the sandbox to a real one.
router.get('/config', (req, res) => {
  const sandboxNumber = (process.env.TWILIO_WHATSAPP_NUMBER || '').replace('whatsapp:', '').replace('+', '');
  res.json({ whatsappNumber: sandboxNumber });
});

// Powers the website chat widget. Runs through the exact same agent
// logic and database as the WhatsApp webhook, a browser session just
// takes the place of a phone number as the conversation's identity, so
// anyone can try the real agent instantly with no WhatsApp setup at all.
router.post('/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || typeof message !== 'string') {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const result = await processMessage({
      identity: `web:${sessionId}`,
      body: message,
      channel: 'web',
      baseUrl
    });

    res.json({ text: result.text, dashboardLink: result.dashboardLink || null });
  } catch (err) {
    console.error('POST /api/chat error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

// Powers the chat box embedded in the dashboard itself. The PIN is
// checked on every message rather than trusting a session, since the
// business owner already has to know it to be here, this keeps the
// dashboard's chat under the same protection as the dashboard's data.
router.post('/businesses/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { pin, message } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const business = await db.getBusinessById(id);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!business.pin || String(business.pin) !== String(pin)) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    const text = await processForBusiness({ businessId: id, body: message });
    res.json({ text });
  } catch (err) {
    console.error('POST /api/businesses/:id/chat error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

// List all businesses (for a simple business picker on the dashboard)
router.get('/businesses', async (req, res) => {
  try {
    const businesses = await db.getAllBusinesses();
    // Never send PINs to the browser as part of the list
    const safe = businesses.map(({ id, name, business_type }) => ({ id, name, business_type }));
    res.json(safe);
  } catch (err) {
    console.error('GET /api/businesses error:', err);
    res.status(500).json({ error: 'Failed to load businesses' });
  }
});

// Verify a business's dashboard PIN
router.post('/businesses/:id/verify-pin', async (req, res) => {
  try {
    const { id } = req.params;
    const { pin } = req.body;
    const business = await db.getBusinessById(id);
    if (!business) return res.status(404).json({ ok: false, error: 'Business not found' });
    const ok = business.pin && String(business.pin) === String(pin);
    res.json({ ok });
  } catch (err) {
    console.error('POST /api/businesses/:id/verify-pin error:', err);
    res.status(500).json({ ok: false, error: 'Failed to verify PIN' });
  }
});

// Full dashboard data for one business: recent transactions, totals, top items, credit
router.get('/businesses/:id/dashboard', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now);
    monthStart.setDate(now.getDate() - 30);

    const weekTxns = await db.getTransactionsForWeek(id, weekStart.toISOString(), now.toISOString());
    const monthTxns = await db.getTransactionsForWeek(id, monthStart.toISOString(), now.toISOString());

    const sum = (txns, type) =>
      txns.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount), 0);

    const weekSales = sum(weekTxns, 'sale');
    const weekExpenses = sum(weekTxns, 'expense');
    const monthSales = sum(monthTxns, 'sale');
    const monthExpenses = sum(monthTxns, 'expense');

    // Build a day-by-day series for the last 7 days for a simple chart
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dayKey = d.toISOString().slice(0, 10);
      const daySales = weekTxns
        .filter((t) => t.type === 'sale' && t.created_at.slice(0, 10) === dayKey)
        .reduce((s, t) => s + Number(t.amount), 0);
      const dayExpenses = weekTxns
        .filter((t) => t.type === 'expense' && t.created_at.slice(0, 10) === dayKey)
        .reduce((s, t) => s + Number(t.amount), 0);
      days.push({
        date: dayKey,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        sales: daySales,
        expenses: dayExpenses
      });
    }

    const recentTransactions = [...monthTxns]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);

    // Quick exact-match grouping for a fast dashboard view. The WhatsApp
    // weekly report uses Gemini to group similar wording together, which
    // is worth the extra latency there but not on every dashboard load.
    const itemCounts = {};
    monthTxns
      .filter((t) => t.type === 'sale' && t.description)
      .forEach((t) => {
        const key = t.description.trim().toLowerCase();
        if (!itemCounts[key]) itemCounts[key] = { item: t.description.trim(), count: 0, totalAmount: 0 };
        itemCounts[key].count += 1;
        itemCounts[key].totalAmount += Number(t.amount);
      });
    const topItems = Object.values(itemCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const outstandingCredits = await db.getOutstandingCredits(id);
    const inventory = await db.getInventoryForBusiness(id);
    const pendingPayables = await db.getPendingPayables(id);
    const business = await db.getBusinessById(id);

    res.json({
      profile: {
        name: business.name,
        businessType: business.business_type,
        email: business.email || null,
        createdAt: business.created_at
      },
      week: { sales: weekSales, expenses: weekExpenses, profit: weekSales - weekExpenses, count: weekTxns.length },
      month: { sales: monthSales, expenses: monthExpenses, profit: monthSales - monthExpenses, count: monthTxns.length },
      days,
      recentTransactions,
      topItems,
      outstandingCredits,
      inventory,
      pendingPayables
    });
  } catch (err) {
    console.error('GET /api/businesses/:id/dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Regenerates a business's dashboard PIN. Requires the current PIN to
// prove ownership, same protection model as everything else here. If
// the owner supplies their own choice of 4-digit PIN, use that instead
// of generating a random one, so they can pick something memorable.
router.post('/businesses/:id/regenerate-pin', async (req, res) => {
  try {
    const { id } = req.params;
    const { pin, newPin: requestedPin } = req.body;
    const business = await db.getBusinessById(id);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!business.pin || String(business.pin) !== String(pin)) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    let newPin;
    if (requestedPin) {
      if (!/^\d{4}$/.test(String(requestedPin))) {
        return res.status(400).json({ error: 'Your chosen PIN must be exactly 4 digits' });
      }
      newPin = String(requestedPin);
    } else {
      newPin = String(Math.floor(1000 + Math.random() * 9000));
    }

    await db.updateBusinessPin(id, newPin);
    res.json({ pin: newPin });
  } catch (err) {
    console.error('POST /api/businesses/:id/regenerate-pin error:', err);
    res.status(500).json({ error: 'Failed to regenerate PIN' });
  }
});

// Downloadable monthly PDF statement, protected by the same PIN as the dashboard
router.get('/businesses/:id/statement.pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const { pin } = req.query;

    const business = await db.getBusinessById(id);
    if (!business) return res.status(404).send('Business not found');
    if (!business.pin || String(business.pin) !== String(pin)) {
      return res.status(401).send('Incorrect or missing PIN');
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const txns = await db.getTransactionsForWeek(id, monthStart.toISOString(), now.toISOString());
    const outstandingCredits = await db.getOutstandingCredits(id);

    const totalSales = txns.filter((t) => t.type === 'sale').reduce((s, t) => s + Number(t.amount), 0);
    const totalExpenses = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const profit = totalSales - totalExpenses;

    const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${business.name.replace(/\s+/g, '_')}_statement.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text(business.name, { continued: false });
    doc.fontSize(11).fillColor('#555555').text(`Business statement, ${monthLabel}`);
    doc.moveDown(1.2);

    doc.fillColor('#000000').fontSize(13).text('Summary');
    doc.moveDown(0.4);
    doc.fontSize(11);
    doc.text(`Total sales: NGN ${totalSales.toLocaleString()}`);
    doc.text(`Total expenses: NGN ${totalExpenses.toLocaleString()}`);
    doc.text(`Net profit: NGN ${profit.toLocaleString()}`);
    doc.text(`Transactions recorded: ${txns.length}`);
    doc.moveDown(1);

    if (outstandingCredits.length) {
      doc.fontSize(13).text('Outstanding customer credit');
      doc.moveDown(0.4);
      doc.fontSize(11);
      outstandingCredits.forEach((c) => {
        doc.text(`${c.customerName}: NGN ${c.balance.toLocaleString()}`);
      });
      const totalCredit = outstandingCredits.reduce((s, c) => s + c.balance, 0);
      doc.moveDown(0.2);
      doc.text(`Total owed to business: NGN ${totalCredit.toLocaleString()}`);
      doc.moveDown(1);
    }

    doc.fontSize(13).text('Transaction log');
    doc.moveDown(0.4);
    doc.fontSize(10);

    if (!txns.length) {
      doc.text('No transactions recorded this month.');
    } else {
      const sorted = [...txns].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      sorted.forEach((t) => {
        const date = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const sign = t.type === 'sale' ? '+' : '-';
        doc.text(`${date}   ${t.type === 'sale' ? 'Sale' : 'Expense'}   ${sign}NGN ${Number(t.amount).toLocaleString()}   ${t.description || ''}`);
      });
    }

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor('#888888').text('Generated by BizAgent, an AI business operations agent.');

    doc.end();
  } catch (err) {
    console.error('GET /api/businesses/:id/statement.pdf error:', err);
    res.status(500).send('Failed to generate statement');
  }
});

module.exports = router;
