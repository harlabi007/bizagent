// CLI entrypoint for manually running weekly reports:
// npm run cron:weekly-report
require('dotenv').config();
const { runWeeklyReports } = require('../services/weeklyReportService');

runWeeklyReports()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
