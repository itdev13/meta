const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Bring-your-own proxy pool, keyed by ISO-2 country code.
 *
 *   PROXY_POOL_JSON={"GB":["http://user:pass@gb1.proxy.example:8000"],"IN":["socks5://u:p@in1.proxy:1080"]}
 *
 * Supported schemes: http, https (both tunnel via CONNECT) and socks5 / socks5h / socks4 / socks4a.
 * A session with settings.proxyCountry = "GB" always gets the same GB proxy (stable hash of its
 * session id), so WhatsApp keeps seeing one IP per number. Credentials are never logged.
 */

const HTTP_SCHEMES = new Set(['http:', 'https:']);
const SOCKS_SCHEMES = new Set(['socks:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:']);

let cache = null; // { raw, pool: Map<country, string[]> }

/** "http://user:pass@host:8000" → "http://***:***@host:8000". Never throws. */
function maskProxyUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '').replace(/\/\/[^@/]*@/, '//***@');
  }
}

function load() {
  const raw = process.env.PROXY_POOL_JSON || '';
  if (cache && cache.raw === raw) return cache.pool;
  const pool = new Map();
  if (raw.trim()) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`[proxy] PROXY_POOL_JSON is not valid JSON — proxies disabled (${err.message})`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, list] of Object.entries(parsed)) {
        const code = String(key).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) {
          console.warn(`[proxy] ignoring pool key "${key}" (expected an ISO-2 country code)`);
          continue;
        }
        const urls = [];
        for (const entry of Array.isArray(list) ? list : [list]) {
          const url = String(entry || '').trim();
          if (!url) continue;
          let scheme = '';
          try {
            scheme = new URL(url).protocol;
          } catch {
            /* invalid */
          }
          if (!HTTP_SCHEMES.has(scheme) && !SOCKS_SCHEMES.has(scheme)) {
            console.warn(`[proxy] ignoring ${code} proxy ${maskProxyUrl(url)} (unsupported or invalid URL)`);
            continue;
          }
          if (!urls.includes(url)) urls.push(url);
        }
        if (urls.length) pool.set(code, urls);
      }
    } else if (parsed !== null) {
      console.error('[proxy] PROXY_POOL_JSON must be an object of { "CC": ["url", ...] } — proxies disabled');
    }
  }
  cache = { raw, pool };
  return pool;
}

function isEnabled() {
  return load().size > 0;
}

function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/** → [{ code, name, count }] sorted by name. Never includes URLs. */
function listCountries() {
  return [...load().entries()]
    .map(([code, urls]) => ({ code, name: countryName(code), count: urls.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stableIndex(key, n) {
  const h = crypto.createHash('sha1').update(String(key)).digest();
  return h.readUInt32BE(0) % n;
}

/**
 * Pick the proxy for a session. → null when no country is set,
 * { country, url, masked, missing: true } when the country has no proxies (connect directly),
 * { country, url, masked } otherwise.
 */
function pickProxy(sessionId, country) {
  const code = String(country || '').trim().toUpperCase();
  if (!code) return null;
  const urls = load().get(code);
  if (!urls?.length) return { country: code, url: null, masked: null, missing: true };
  const url = urls[stableIndex(sessionId, urls.length)];
  return { country: code, url, masked: maskProxyUrl(url) };
}

/** Build an http(s).Agent for a proxy URL (usable as Baileys `agent` and axios `httpsAgent`). */
function createAgent(url) {
  const scheme = new URL(url).protocol;
  if (SOCKS_SCHEMES.has(scheme)) return new SocksProxyAgent(url);
  return new HttpsProxyAgent(url);
}

module.exports = { maskProxyUrl, isEnabled, listCountries, pickProxy, createAgent, countryName };
