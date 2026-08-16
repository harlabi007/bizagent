const gemini = require('./geminiService');
const db = require('./supabaseService');
const paystack = require('./paystackService');

// In-memory onboarding state, keyed by a channel-agnostic identity string
// (e.g. "whatsapp:+234..." or "web:<sessionId>"). Fine for MVP scale; move
// to the database if this needs to survive server restarts.
const pendingOnboarding = new Map();

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit PIN
}

function getCustomerLink(businessName) {
  const sandboxNumber = (process.env.TWILIO_WHATSAPP_NUMBER || '').replace('whatsapp:', '').replace('+', '');
  const prefill = encodeURIComponent(`Hi ${businessName}, `);
  return `https://wa.me/${sandboxNumber}?text=${prefill}`;
}

// Try to match an incoming message to a business by name, for messages
// that arrive via a business's shareable customer link (which prefills
// "Hi <business name>, "). Only meaningful on the WhatsApp channel, where
// customers reach a specific business through the one shared number.
async function matchBusinessFromMessage(body) {
  if (!body) return null;
  const businesses = await db.getAllBusinesses();
  const lowerBody = body.toLowerCase();
  return businesses.find((b) => lowerBody.includes(b.name.toLowerCase())) || null;
}

async function buildBusinessDataSummary(businessId) {
  const now = new Date();
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(now.getDate() - 60);

  const txns = await db.getTransactionsForWeek(businessId, sixtyDaysAgo.toISOString(), now.toISOString());

  const weekBoundaries = [7, 14, 21, 28].map((d) => {
    const start = new Date(now);
    start.setDate(now.getDate() - d);
    return start;
  });

  function sumBetween(start, end, type) {
    return txns
      .filter((t) => {
        const d = new Date(t.created_at);
        return d >= start && d < end && t.type === type;
      })
      .reduce((s, t) => s + Number(t.amount), 0);
  }

  const thisWeekSales = sumBetween(weekBoundaries[0], now, 'sale');
  const thisWeekExpenses = sumBetween(weekBoundaries[0], now, 'expense');
  const lastWeekSales = sumBetween(weekBoundaries[1], weekBoundaries[0], 'sale');
  const lastWeekExpenses = sumBetween(weekBoundaries[1], weekBoundaries[0], 'expense');
  const twoWeeksAgoSales = sumBetween(weekBoundaries[2], weekBoundaries[1], 'sale');

  const outstanding = await db.getOutstandingCredits(businessId);
  const creditTotal = outstanding.reduce((s, c) => s + c.balance, 0);

  const inventory = await db.getInventoryForBusiness(businessId);
  const lowStock = inventory.filter((i) => Number(i.current_stock) <= Number(i.low_stock_threshold));

  return `
This week's sales: NGN ${thisWeekSales}, expenses: NGN ${thisWeekExpenses}, profit: NGN ${thisWeekSales - thisWeekExpenses}
Last week's sales: NGN ${lastWeekSales}, expenses: NGN ${lastWeekExpenses}, profit: NGN ${lastWeekSales - lastWeekExpenses}
Two weeks ago sales: NGN ${twoWeeksAgoSales}
Total transactions in last 60 days: ${txns.length}
Outstanding customer credit owed to business: NGN ${creditTotal}
Items currently low on stock: ${lowStock.length ? lowStock.map((i) => i.item_name).join(', ') : 'none'}
`.trim();
}

async function computeAuditFindings(businessId) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const txns = await db.getTransactionsForWeek(businessId, thirtyDaysAgo.toISOString(), now.toISOString());
  const totalSales = txns.filter((t) => t.type === 'sale').reduce((s, t) => s + Number(t.amount), 0);
  const totalExpenses = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
  const avgTransaction = txns.length ? Math.round((totalSales + totalExpenses) / txns.length) : 0;

  const flags = [];

  if (avgTransaction > 0) {
    txns
      .filter((t) => Number(t.amount) > avgTransaction * 3)
      .forEach((t) => {
        const date = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        flags.push(`Unusually large ${t.type} on ${date}: NGN ${Number(t.amount).toLocaleString()} (${t.description || 'no description'})`);
      });
  }

  const creditEntries = await db.getAllCreditEntries(businessId);
  const byCustomer = {};
  creditEntries.forEach((e) => {
    if (!byCustomer[e.customer_name]) byCustomer[e.customer_name] = 0;
    byCustomer[e.customer_name] += e.type === 'debt' ? Number(e.amount) : -Number(e.amount);
  });
  Object.entries(byCustomer).forEach(([name, balance]) => {
    if (balance < 0) {
      flags.push(`${name} appears to have paid more than they were recorded as owing (overpaid by NGN ${Math.abs(balance).toLocaleString()}). Worth checking if a debt entry was missed.`);
    }
  });

  return {
    stats: { transactionCount: txns.length, days: 30, totalSales, totalExpenses, avgTransaction },
    flags
  };
}

/**
 * The agent's single entry point, used by both the WhatsApp webhook and
 * the website chat widget. Same identity concept (a unique string per
 * conversation), same database, same decision logic either way, only the
 * transport in and out differs.
 *
 * identity: a unique string for this conversation, e.g. "whatsapp:+234..."
 *           or "web:<sessionId>"
 * channel: "whatsapp" or "web", only used to skip channel-specific bits
 *          like customer shareable links and voice notes on the web
 * mediaUrl / mediaType / twilioAuth: only relevant on the whatsapp channel
 *
 * Returns { text, dashboardLink } where dashboardLink is only set right
 * when a new business finishes onboarding.
 */
async function processMessage({ identity, body, channel, baseUrl, mediaUrl, mediaType, twilioAuth }) {
  body = (body || '').trim();
  let business = await db.getBusinessByPhone(identity);

  // --- CUSTOMER MESSAGE VIA SHAREABLE LINK (WhatsApp only) ---
  if (!business && channel === 'whatsapp') {
    const matchedBusiness = await matchBusinessFromMessage(body);
    if (matchedBusiness) {
      const decision = await gemini.classifyMessage({ message: body, isOwner: false });
      const topic = decision.topic || decision.note || 'general inquiry';
      const reply = await gemini.generateCustomerReply({
        businessName: matchedBusiness.name,
        businessType: matchedBusiness.business_type,
        topic,
        customerMessage: body
      });
      await db.logCustomerMessage({
        businessId: matchedBusiness.id,
        customerPhone: identity,
        incomingMessage: body,
        agentReply: reply
      });
      return { text: reply, dashboardLink: null };
    }
  }

  // --- ONBOARDING FLOW ---
  if (!business) {
    const state = pendingOnboarding.get(identity);

    if (!state) {
      pendingOnboarding.set(identity, { step: 'awaiting_details' });
      return {
        text: `Welcome! I'm your AI business assistant.\n\nTo set up, reply with your business name and type, like:\n"Chidi's Salon, hair salon"`,
        dashboardLink: null
      };
    }

    if (state.step === 'awaiting_details') {
      const [name, businessType] = body.split(',').map((s) => s.trim());
      const junkWords = ['hi', 'hello', 'hey', 'test', 'testing', 'ok', 'okay', 'yo', 'sup'];
      if (!name || name.length < 3 || junkWords.includes(name.toLowerCase())) {
        return {
          text: `That doesn't look like a business name yet. Please reply with your real business name and type, like: "Chidi's Salon, hair salon"`,
          dashboardLink: null
        };
      }
      pendingOnboarding.set(identity, { step: 'awaiting_email', name, businessType: businessType || 'general' });
      return {
        text: `Got it, ${name}. What's a good email for you, in case we ever need to reach you about your account? Reply "skip" if you'd rather not.`,
        dashboardLink: null
      };
    }

    if (state.step === 'awaiting_email') {
      const emailInput = body.trim();
      const looksLikeEmail = /\S+@\S+\.\S+/.test(emailInput);
      const email = looksLikeEmail ? emailInput : null;

      const pin = generatePin();
      business = await db.createBusiness({
        name: state.name,
        ownerPhone: identity,
        businessType: state.businessType,
        pin,
        email
      });
      pendingOnboarding.delete(identity);
      const dashboardLink = `${baseUrl}/dashboard.html?biz=${business.id}&pin=${pin}`;

      const customerLinkLine = channel === 'whatsapp'
        ? `\n\nShare this link so customers can message your AI assistant directly: ${getCustomerLink(state.name)}`
        : '\n\nYou can also do all of this for real over WhatsApp once you are ready.';

      return {
        text: `You're set up, ${state.name}! 🎉\n\nSome things you can say to me:\n- "Sold 5k of rice" to log a sale\n- "Spent 2k on transport" to log an expense\n- "Chidi owes 5k for rice" to log a customer credit\n- "Chidi paid 5k" to log a payment received\n- "who owes me" to see outstanding credit\n- "Restocked 20 bags of rice" to track inventory\n- "check my stock" to see current inventory\n- "I need to pay Chidi's Supplies 15k for rice" to prepare a payment\n- "pay Chidi's Supplies" to send a prepared payment\n- "check my books" for an audit\n- "how much tax will I pay" for a tax estimate\n- "how am I doing compared to last month" to ask me anything about your business\n- "report" for your weekly summary\n\nVoice notes and receipt photos work too on WhatsApp.\n\nYour dashboard PIN is ${pin} if you need it later.${customerLinkLine}`,
        dashboardLink
      };
    }
  }

  // --- VOICE NOTE and RECEIPT IMAGE are WhatsApp-only, handled here
  // before handing off to the shared owner-message handler ---
  if (mediaUrl && mediaType && mediaType.startsWith('audio/')) {
    const axios = require('axios');
    const audioResp = await axios.get(mediaUrl, { responseType: 'arraybuffer', auth: twilioAuth });
    const base64Audio = Buffer.from(audioResp.data).toString('base64');
    body = await gemini.transcribeVoiceNote({ base64Audio, mimeType: mediaType });
  }

  if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
    const axios = require('axios');
    const imageResp = await axios.get(mediaUrl, { responseType: 'arraybuffer', auth: twilioAuth });
    const base64Image = Buffer.from(imageResp.data).toString('base64');
    const parsed = await gemini.parseReceiptImage({ base64Image, mimeType: mediaType });

    if (parsed.amount) {
      await db.logTransaction({
        businessId: business.id,
        type: 'expense',
        amount: parsed.amount,
        description: parsed.description,
        rawMessage: '[receipt photo]'
      });
      return { text: `Logged expense: ₦${parsed.amount}, ${parsed.description}`, dashboardLink: null };
    }
    return { text: `I could not read that receipt clearly. Can you tell me the amount and what it was for?`, dashboardLink: null };
  }

  const replyText = await handleOwnerMessage({ business, body });
  return { text: replyText, dashboardLink: null };
}

/**
 * Handles a message from someone we already know is the owner of a
 * specific business, no identity lookup or onboarding needed. Used both
 * after onboarding completes in processMessage, and directly by the
 * dashboard's built-in chat, which authenticates with the business's
 * PIN instead of a phone number or session.
 */
async function handleOwnerMessage({ business, body }) {
  const decision = await gemini.classifyMessage({ message: body, isOwner: true });

  switch (decision.intent) {
    case 'log_sale': {
      await db.logTransaction({
        businessId: business.id,
        type: 'sale',
        amount: decision.amount,
        description: decision.description,
        rawMessage: body
      });

      let stockNote = '';
      if (decision.itemName && decision.quantity) {
        const updated = await db.adjustStock({
          businessId: business.id,
          itemName: decision.itemName,
          unit: decision.unit,
          delta: -Math.abs(decision.quantity)
        });
        if (updated) {
          stockNote = `\n${updated.item_name}: ${updated.current_stock} ${updated.unit || ''} left`;
          if (Number(updated.current_stock) <= Number(updated.low_stock_threshold)) {
            stockNote += ` ⚠️ running low`;
          }
        }
      }

      return `Logged sale: ₦${decision.amount}, ${decision.description} ✅${stockNote}`;
    }
    case 'log_expense': {
      await db.logTransaction({
        businessId: business.id,
        type: 'expense',
        amount: decision.amount,
        description: decision.description,
        rawMessage: body
      });
      return `Logged expense: ₦${decision.amount}, ${decision.description} ✅`;
    }
    case 'log_credit': {
      await db.logCreditEntry({
        businessId: business.id,
        customerName: decision.customerName,
        type: 'debt',
        amount: decision.amount,
        description: decision.description
      });
      return `Logged: ${decision.customerName} owes ₦${decision.amount} for ${decision.description} ✅`;
    }
    case 'log_credit_payment': {
      await db.logCreditEntry({
        businessId: business.id,
        customerName: decision.customerName,
        type: 'payment',
        amount: decision.amount,
        description: 'payment received'
      });
      const outstanding = await db.getOutstandingCredits(business.id);
      const remaining = outstanding.find((c) => c.customerName.toLowerCase() === decision.customerName.toLowerCase());
      const remainingText = remaining ? `They still owe ₦${remaining.balance}.` : `They are now fully paid up.`;
      return `Logged: ${decision.customerName} paid ₦${decision.amount} ✅ ${remainingText}`;
    }
    case 'ask_credits': {
      const outstanding = await db.getOutstandingCredits(business.id);
      if (!outstanding.length) return `No one currently owes you money. Your credit book is clear.`;
      const lines = outstanding.map((c) => `${c.customerName}: ₦${c.balance}`).join('\n');
      const total = outstanding.reduce((s, c) => s + c.balance, 0);
      return `Outstanding credit:\n${lines}\n\nTotal owed to you: ₦${total}`;
    }
    case 'log_restock': {
      const updated = await db.adjustStock({
        businessId: business.id,
        itemName: decision.item,
        unit: decision.unit,
        delta: Math.abs(decision.quantity)
      });
      return `Restocked: ${updated.item_name} is now at ${updated.current_stock} ${updated.unit || ''} ✅`;
    }
    case 'ask_stock': {
      const inventory = await db.getInventoryForBusiness(business.id);
      if (!inventory.length) {
        return `No stock tracked yet. Tell me when you restock something, like "Restocked 20 bags of rice", and I will start tracking it.`;
      }
      const lines = inventory.map((i) => {
        const low = Number(i.current_stock) <= Number(i.low_stock_threshold) ? ' ⚠️ low' : '';
        return `${i.item_name}: ${i.current_stock} ${i.unit || ''}${low}`;
      });
      return `Current stock:\n${lines.join('\n')}`;
    }
    case 'ask_audit': {
      const { stats, flags } = await computeAuditFindings(business.id);
      const summary = await gemini.generateAuditSummary({ businessName: business.name, stats, flags });
      return summary;
    }
    case 'log_payable': {
      await db.createPayable({
        businessId: business.id,
        payeeName: decision.payeeName,
        amount: decision.amount,
        reason: decision.reason,
        accountNumber: decision.accountNumber,
        bankName: decision.bankName
      });
      return `Noted. Payment of ₦${decision.amount} to ${decision.payeeName} for ${decision.reason} is ready. When you want it sent, reply "pay ${decision.payeeName}" and I will handle it, or hand you the details to send yourself.`;
    }
    case 'confirm_payment': {
      const payable = await db.getPendingPayableByName(business.id, decision.payeeName);
      if (!payable) {
        return `I don't have a pending payment for ${decision.payeeName}. Tell me the amount and reason first, e.g. "I need to pay ${decision.payeeName} 15k for supplies".`;
      }

      let handled = false;
      let resultText = '';
      if (paystack.isConfigured() && payable.account_number && payable.bank_name) {
        const bankCode = await paystack.getBankCode(payable.bank_name);
        if (bankCode) {
          const recipient = await paystack.createTransferRecipient({ name: payable.payee_name, accountNumber: payable.account_number, bankCode });
          if (recipient.success) {
            const transfer = await paystack.initiateTransfer({
              recipientCode: recipient.recipientCode,
              amount: payable.amount,
              reason: payable.reason,
              reference: `bizagent-${payable.id}`
            });
            if (transfer.success) {
              await db.markPayableSent(payable.id);
              resultText = `Sent ₦${payable.amount} to ${payable.payee_name} for ${payable.reason} ✅`;
              handled = true;
            }
          }
        }
      }

      if (!handled) {
        await db.markPayableSent(payable.id);
        const bankInfo = payable.account_number
          ? `${payable.account_number}, ${payable.bank_name || 'bank not specified'}`
          : 'no account details on file, please send manually with your own records';
        resultText = `Here is what to send: ₦${payable.amount} to ${payable.payee_name} (${bankInfo}), reference: ${payable.reason}. I have marked this as handled in your records.`;
      }
      return resultText;
    }
    case 'ask_payables': {
      const pending = await db.getPendingPayables(business.id);
      if (!pending.length) return `You have no pending payments right now.`;
      const lines = pending.map((p) => `${p.payee_name}: ₦${p.amount} for ${p.reason}`).join('\n');
      const total = pending.reduce((s, p) => s + Number(p.amount), 0);
      return `Pending payments:\n${lines}\n\nTotal: ₦${total}`;
    }
    case 'ask_business_question': {
      const dataSummary = await buildBusinessDataSummary(business.id);
      const answer = await gemini.answerBusinessQuestion({ businessName: business.name, question: decision.question, dataSummary });
      return answer;
    }
    case 'ask_tax_estimate': {
      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(now.getDate() - 30);
      const txns = await db.getTransactionsForWeek(business.id, thirtyDaysAgo.toISOString(), now.toISOString());
      const monthlyTurnover = txns.filter((t) => t.type === 'sale').reduce((s, t) => s + Number(t.amount), 0);
      const annualizedTurnover = monthlyTurnover * 12;
      const estimate = await gemini.generateTaxEstimate({ businessName: business.name, monthlyTurnover, annualizedTurnover });
      return estimate;
    }
    case 'ask_report': {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - 7);
      const txns = await db.getTransactionsForWeek(business.id, weekStart.toISOString(), now.toISOString());
      const totalSales = txns.filter((t) => t.type === 'sale').reduce((s, t) => s + Number(t.amount), 0);
      const totalExpenses = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);

      const summary = await gemini.generateWeeklySummary({
        businessName: business.name,
        totalSales,
        totalExpenses,
        profit: totalSales - totalExpenses,
        bestDay: 'this week',
        transactionCount: txns.length
      });

      const topItems = await gemini.analyzeTopItems({
        sales: txns.filter((t) => t.type === 'sale').map((t) => ({ description: t.description, amount: t.amount }))
      });
      const topItemsLine = topItems.length ? `\n\nTop sellers: ${topItems.map((i) => `${i.item} (${i.count}x)`).join(', ')}` : '';

      const outstanding = await db.getOutstandingCredits(business.id);
      const creditTotal = outstanding.reduce((s, c) => s + c.balance, 0);
      const creditLine = creditTotal > 0 ? `\nOutstanding credit owed to you: ₦${creditTotal}` : '';

      return summary + topItemsLine + creditLine;
    }
    default: {
      return `Not sure I caught that. Here's everything I can help with:\n- "Sold 5k of rice" to log a sale\n- "Spent 2k on transport" to log an expense\n- "Chidi owes 5k for rice" to log a customer credit\n- "Chidi paid 5k" to log a payment received\n- "who owes me" to see outstanding credit\n- "Restocked 20 bags of rice" to track inventory\n- "check my stock" to see current inventory\n- "I need to pay Chidi's Supplies 15k for rice" to prepare a payment\n- "pay Chidi's Supplies" to send a prepared payment\n- "who do I need to pay" to see pending payments\n- "check my books" for an audit\n- "how much tax will I pay" for a tax estimate\n- "how am I doing compared to last month" to ask me anything\n- "report" for your weekly summary`;
    }
  }
}

/**
 * Runs a message for a business we've already authenticated by PIN, no
 * identity lookup or onboarding, this is used by the dashboard's chat,
 * where knowing the PIN already proves who you are.
 */
async function processForBusiness({ businessId, body }) {
  const business = await db.getBusinessById(businessId);
  if (!business) return 'Could not find that business.';
  return handleOwnerMessage({ business, body });
}

module.exports = { processMessage, processForBusiness };
