require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const whatsappRoutes = require('./routes/whatsapp');
const apiRoutes = require('./routes/api');
const { runWeeklyReports } = require('./services/weeklyReportService');
const { runDailyChecks } = require('./services/dailyOpsService');

const app = express();
// Render (and most hosts) sit the app behind a proxy that terminates
// HTTPS and forwards plain HTTP internally. Without this, req.protocol
// always reports "http", which breaks any link we build from it, like
// the dashboard auto-login link sent in the WhatsApp welcome message.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/whatsapp', whatsappRoutes);
app.use('/api', apiRoutes);

// Schedule weekly reports every Sunday at 6pm WAT (17:00 UTC)
cron.schedule('0 17 * * 0', () => {
  console.log('Running scheduled weekly reports...');
  runWeeklyReports().catch((err) => console.error('Weekly report cron failed:', err));
});

// Schedule daily nudges and spending alerts every day at 7pm WAT (18:00 UTC)
cron.schedule('0 18 * * *', () => {
  console.log('Running daily checks...');
  runDailyChecks().catch((err) => console.error('Daily checks cron failed:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BizAgent server listening on port ${PORT}`);
});
