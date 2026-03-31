#!/usr/bin/env node
/**
 * Shopify Auto-Tagger Service
 * Runs on a schedule and applies/removes tags based on configurable rules.
 */

import { runAllRules } from './tagger.js';
import { log } from './logger.js';
import cron from 'node-cron';
import { SCHEDULE } from './config.js';

log('info', '🚀 Shopify Auto-Tagger started');
log('info', `📅 Schedule: "${SCHEDULE}"`);

// Run immediately on startup
runAllRules();

// Then run on the configured cron schedule
cron.schedule(SCHEDULE, () => {
  log('info', '⏰ Scheduled run triggered');
  runAllRules();
});
