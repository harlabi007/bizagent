const axios = require('axios');

const PAYSTACK_BASE = 'https://api.paystack.co';

function isConfigured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

function client() {
  return axios.create({
    baseURL: PAYSTACK_BASE,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
  });
}

/**
 * Registers a payee as a Paystack transfer recipient. Required once per
 * payee before a real transfer can be sent to them.
 */
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  if (!isConfigured()) {
    return { success: false, reason: 'Paystack is not configured on this server yet.' };
  }
  try {
    const res = await client().post('/transferrecipient', {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN'
    });
    return { success: true, recipientCode: res.data.data.recipient_code };
  } catch (err) {
    return { success: false, reason: err.response?.data?.message || err.message };
  }
}

/**
 * Sends a real transfer. Only ever called after the business owner has
 * explicitly confirmed the payment in WhatsApp, never automatically.
 */
async function initiateTransfer({ recipientCode, amount, reason, reference }) {
  if (!isConfigured()) {
    return { success: false, reason: 'Paystack is not configured on this server yet.' };
  }
  try {
    const res = await client().post('/transfer', {
      source: 'balance',
      amount: Math.round(amount * 100), // kobo
      recipient: recipientCode,
      reason,
      reference
    });
    return { success: true, data: res.data.data };
  } catch (err) {
    return { success: false, reason: err.response?.data?.message || err.message };
  }
}

let bankListCache = null;

/**
 * Looks up a Paystack bank code from a plain bank name the owner typed,
 * e.g. "GTBank" or "Access Bank". Cached after the first successful call.
 */
async function getBankCode(bankName) {
  if (!isConfigured() || !bankName) return null;
  try {
    if (!bankListCache) {
      const res = await client().get('/bank?country=nigeria');
      bankListCache = res.data.data;
    }
    const lower = bankName.toLowerCase();
    const match = bankListCache.find(
      (b) => b.name.toLowerCase().includes(lower) || lower.includes(b.name.toLowerCase())
    );
    return match ? match.code : null;
  } catch (err) {
    return null;
  }
}

module.exports = { isConfigured, createTransferRecipient, initiateTransfer, getBankCode };
