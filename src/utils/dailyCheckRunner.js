// CLI entrypoint for manually running daily checks:
// npm run cron:daily-checks
require('dotenv').config();
const { runDailyChecks } = require('../services/dailyOpsService');

runDailyChecks()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
