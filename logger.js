/**
 * Minimal logger — writes timestamped lines to stdout.
 * In production, pipe stdout to a log file or a service like Papertrail / Datadog.
 */

export function log(level, message) {
  const ts = new Date().toISOString();
  const prefix = { info: 'ℹ', error: '✖', warn: '⚠' }[level] ?? '•';
  console.log(`[${ts}] ${prefix}  ${message}`);
}
