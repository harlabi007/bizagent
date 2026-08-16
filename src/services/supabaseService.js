const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getBusinessByPhone(phone) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('owner_phone', phone)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createBusiness({ name, ownerPhone, businessType, pin, email }) {
  const { data, error } = await supabase
    .from('businesses')
    .insert({ name, owner_phone: ownerPhone, business_type: businessType, pin, email: email || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getBusinessById(id) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function logTransaction({ businessId, type, amount, description, rawMessage }) {
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      business_id: businessId,
      type,
      amount,
      description,
      raw_message: rawMessage
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getTransactionsForWeek(businessId, weekStart, weekEnd) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('business_id', businessId)
    .gte('created_at', weekStart)
    .lte('created_at', weekEnd);
  if (error) throw error;
  return data;
}

async function logCustomerMessage({ businessId, customerPhone, incomingMessage, agentReply }) {
  const { error } = await supabase
    .from('customer_messages')
    .insert({
      business_id: businessId,
      customer_phone: customerPhone,
      incoming_message: incomingMessage,
      agent_reply: agentReply
    });
  if (error) throw error;
}

async function saveWeeklyReport(report) {
  const { error } = await supabase.from('weekly_reports').insert(report);
  if (error) throw error;
}

async function getAllBusinesses() {
  const { data, error } = await supabase.from('businesses').select('*');
  if (error) throw error;
  return data;
}

async function logCreditEntry({ businessId, customerName, type, amount, description }) {
  const { data, error } = await supabase
    .from('credit_entries')
    .insert({
      business_id: businessId,
      customer_name: customerName,
      type,
      amount,
      description
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getOutstandingCredits(businessId) {
  const { data, error } = await supabase
    .from('credit_entries')
    .select('*')
    .eq('business_id', businessId);
  if (error) throw error;

  const balances = {};
  for (const entry of data) {
    const name = entry.customer_name;
    if (!balances[name]) balances[name] = 0;
    balances[name] += entry.type === 'debt' ? Number(entry.amount) : -Number(entry.amount);
  }

  return Object.entries(balances)
    .map(([customerName, balance]) => ({ customerName, balance }))
    .filter((c) => c.balance > 0)
    .sort((a, b) => b.balance - a.balance);
}

// --- Inventory ---

async function findInventoryItem(businessId, itemName) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('business_id', businessId)
    .ilike('item_name', itemName)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Adjusts stock for an item, creating it if it does not exist yet.
 * delta is positive for a restock, negative for a sale. Stock never
 * goes below zero, since a negative count is not meaningful to an owner.
 */
async function adjustStock({ businessId, itemName, unit, delta }) {
  const existing = await findInventoryItem(businessId, itemName);

  if (!existing) {
    if (delta <= 0) return null; // nothing to track if we have never stocked it
    const { data, error } = await supabase
      .from('inventory_items')
      .insert({
        business_id: businessId,
        item_name: itemName,
        unit,
        current_stock: delta,
        low_stock_threshold: Math.max(1, Math.round(delta * 0.2))
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const newStock = Math.max(0, Number(existing.current_stock) + delta);
  const { data, error } = await supabase
    .from('inventory_items')
    .update({ current_stock: newStock, updated_at: new Date().toISOString(), unit: unit || existing.unit })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getInventoryForBusiness(businessId) {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('business_id', businessId)
    .order('item_name', { ascending: true });
  if (error) throw error;
  return data;
}

// --- Payables ---

async function createPayable({ businessId, payeeName, amount, reason, accountNumber, bankName }) {
  const { data, error } = await supabase
    .from('payables')
    .insert({
      business_id: businessId,
      payee_name: payeeName,
      amount,
      reason,
      account_number: accountNumber || null,
      bank_name: bankName || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getPendingPayableByName(businessId, payeeName) {
  const { data, error } = await supabase
    .from('payables')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'pending')
    .ilike('payee_name', payeeName)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getPendingPayables(businessId) {
  const { data, error } = await supabase
    .from('payables')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getAllCreditEntries(businessId) {
  const { data, error } = await supabase
    .from('credit_entries')
    .select('*')
    .eq('business_id', businessId);
  if (error) throw error;
  return data;
}

async function markPayableSent(id) {
  const { error } = await supabase
    .from('payables')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

async function updateBusinessPin(id, newPin) {
  const { data, error } = await supabase
    .from('businesses')
    .update({ pin: newPin })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  getBusinessByPhone,
  getBusinessById,
  createBusiness,
  logTransaction,
  getTransactionsForWeek,
  logCustomerMessage,
  saveWeeklyReport,
  getAllBusinesses,
  logCreditEntry,
  getOutstandingCredits,
  adjustStock,
  getInventoryForBusiness,
  createPayable,
  getPendingPayableByName,
  getPendingPayables,
  markPayableSent,
  getAllCreditEntries,
  updateBusinessPin
};
