import './server.js';
import { runAllRules } from './tagger.js';
import { log } from './logger.js';
import cron from 'node-cron';
import { SCHEDULE } from './config.js';

log('info', '🚀 Shopify Auto-Tagger started');
log('info', `📅 Schedule: "${SCHEDULE}"`);

// Removed the immediate runAllRules() call — runs on schedule only
cron.schedule(SCHEDULE, () => {
  log('info', '⏰ Scheduled run triggered');
  runAllRules();
});
