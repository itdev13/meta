const util = require('util');
const winston = require('winston');

/**
 * App logger: same style as ConvoVault — winston, coloured level, emoji-led message and
 * structured fields, e.g.
 *   info: 📥 INSTALL webhook {"locationId":"…","companyId":"…","timestamp":"2026-11-04 23:49:07.123 +05:30"}
 *
 * Timestamps are local to LOG_TZ (default Asia/Kolkata). Writes straight to stdout (not via
 * console.*) so the console bridge in main.js can route legacy console calls here safely.
 */
const TZ = process.env.LOG_TZ || 'Asia/Kolkata';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset',
});

function localTimestamp() {
  const d = new Date();
  const p = fmt.formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const offset = (p.timeZoneName || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3, '0')} ${offset}`;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: localTimestamp }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Stream({
      stream: process.stdout,
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

/**
 * Route console.* through the logger, so every legacy `console.log('[WA] …')` line gets the
 * same level + timestamp format. Objects passed as extra args become structured fields.
 */
function bridgeConsole() {
  const map = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
  for (const [method, level] of Object.entries(map)) {
    // eslint-disable-next-line no-console
    console[method] = (...args) => {
      const meta = {};
      const parts = [];
      for (const a of args) {
        if (a instanceof Error) parts.push(a.stack || a.message);
        else if (a && typeof a === 'object' && !Array.isArray(a)) Object.assign(meta, a);
        else parts.push(typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: Infinity }));
      }
      logger.log(level, parts.join(' '), meta);
    };
  }
}

module.exports = logger;
module.exports.bridgeConsole = bridgeConsole;
