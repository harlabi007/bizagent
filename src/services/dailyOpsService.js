const db = require('./supabaseService');
const whatsapp = require('./whatsappService');

/**
 * Runs once a day. This is what makes BizAgent an agent rather than a
 * passive bot: it decides on its own, without being asked, whether a
 * business owner needs a nudge or a warning, and messages them first.
 */
async function runDailyChecks() {
  const businesses = await db.getAllBusinesses();
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const priorWeekStart = new Date(now);
  priorWeekStart.setDate(now.getDate() - 8);
  const priorWeekEnd = new Date(now);
  priorWeekEnd.setDate(now.getDate() - 1);
  priorWeekEnd.setHours(23, 59, 59, 999);

  for (const business of businesses) {
    try {
      const todayTxns = await db.getTransactionsForWeek(business.id, todayStart.toISOString(), now.toISOString());
      const priorWeekTxns = await db.getTransactionsForWeek(
        business.id,
        priorWeekStart.toISOString(),
        priorWeekEnd.toISOString()
      );

      const todaySales = todayTxns.filter((t) => t.type === 'sale').length;
      const todayExpenseTotal = todayTxns
        .filter((t) => t.type === 'expense')
        .reduce((s, t) => s + Number(t.amount), 0);

      const priorExpenseTotal = priorWeekTxns
        .filter((t) => t.type === 'expense')
        .reduce((s, t) => s + Number(t.amount), 0);
      const avgDailyExpense = priorExpenseTotal / 7;

      // Only message when there is something genuinely worth flagging,
      // so the agent does not become spam the owner tunes out.
      if (todayTxns.length === 0 && now.getHours() >= 18) {
        await whatsapp.sendMessage(
          business.owner_phone,
          `Have not heard from you today. How is business going, ${business.name}? Send me any sales or expenses whenever you get a moment.`
        );
        continue;
      }

      if (avgDailyExpense > 0 && todayExpenseTotal > avgDailyExpense * 1.5) {
        const pctOver = Math.round((todayExpenseTotal / avgDailyExpense - 1) * 100);
        await whatsapp.sendMessage(
          business.owner_phone,
          `Quick flag: today's expenses (₦${todayExpenseTotal.toLocaleString()}) are running about ${pctOver}% above your recent daily average. Worth a look if anything seems off.`
        );
      }
    } catch (err) {
      console.error(`Daily check failed for ${business.name}:`, err.message);
    }
  }
}

module.exports = { runDailyChecks };
