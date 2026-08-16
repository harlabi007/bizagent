const db = require('./supabaseService');
const gemini = require('./geminiService');
const whatsapp = require('./whatsappService');

async function runWeeklyReports() {
  const businesses = await db.getAllBusinesses();
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);

  for (const business of businesses) {
    try {
      const txns = await db.getTransactionsForWeek(business.id, weekStart.toISOString(), now.toISOString());
      const totalSales = txns.filter((t) => t.type === 'sale').reduce((s, t) => s + Number(t.amount), 0);
      const totalExpenses = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
      const profit = totalSales - totalExpenses;

      const salesByDay = {};
      txns.filter((t) => t.type === 'sale').forEach((t) => {
        const day = new Date(t.created_at).toLocaleDateString('en-US', { weekday: 'long' });
        salesByDay[day] = (salesByDay[day] || 0) + Number(t.amount);
      });
      const bestDay = Object.entries(salesByDay).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

      const summary = await gemini.generateWeeklySummary({
        businessName: business.name,
        totalSales,
        totalExpenses,
        profit,
        bestDay,
        transactionCount: txns.length
      });

      const topItems = await gemini.analyzeTopItems({
        sales: txns.filter((t) => t.type === 'sale').map((t) => ({ description: t.description, amount: t.amount }))
      });
      const topItemsLine = topItems.length
        ? `\n\nTop sellers: ${topItems.map((i) => `${i.item} (${i.count}x)`).join(', ')}`
        : '';

      const outstanding = await db.getOutstandingCredits(business.id);
      const creditTotal = outstanding.reduce((s, c) => s + c.balance, 0);
      const creditLine = creditTotal > 0 ? `\nOutstanding credit owed to you: ₦${creditTotal}` : '';

      const fullMessage = summary + topItemsLine + creditLine;

      await whatsapp.sendMessage(business.owner_phone, `📊 Weekly report for ${business.name}\n\n${fullMessage}`);

      await db.saveWeeklyReport({
        business_id: business.id,
        week_start: weekStart.toISOString().slice(0, 10),
        week_end: now.toISOString().slice(0, 10),
        total_sales: totalSales,
        total_expenses: totalExpenses,
        profit,
        best_day: bestDay,
        summary_text: fullMessage
      });

      console.log(`Sent weekly report to ${business.name}`);
    } catch (err) {
      console.error(`Failed weekly report for ${business.name}:`, err.message);
    }
  }
}

module.exports = { runWeeklyReports };
