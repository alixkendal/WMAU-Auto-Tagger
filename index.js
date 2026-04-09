import './server.js';
import { runAllRules } from './tagger.js';
import { runGenreTagger } from './genre-tagger.js';
import { log } from './logger.js';
import cron from 'node-cron';
import { SCHEDULE } from './config.js';

const GENRE_SCHEDULE = process.env.GENRE_SCHEDULE || '30 * * * *'; // 30 mins past each hour

log('info', '🚀 Shopify Auto-Tagger started');
log('info', `📅 Rules schedule: "${SCHEDULE}"`);
log('info', `🎵 Genre schedule: "${GENRE_SCHEDULE}"`);

cron.schedule(SCHEDULE, () => {
  log('info', '⏰ Rules run triggered');
  runAllRules();
});

cron.schedule(GENRE_SCHEDULE, () => {
  log('info', '⏰ Genre run triggered');
  runGenreTagger();
});
