const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');
const axios = require('axios');

const MEDIA_DIR = path.resolve(__dirname, '../../tmp/media');
const TTL_MS = (Number(process.env.WA_MEDIA_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD = 64 * 1024 * 1024;

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m.split(';')[0]]));
Object.assign(MIME_BY_EXT, { jpeg: 'image/jpeg', opus: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });

function extFor(mime, filename) {
  const fromName = filename && path.extname(filename).slice(1).toLowerCase();
  return fromName || EXT[mime] || EXT[String(mime || '').split(';')[0]] || 'bin';
}

function mimeFor(urlOrName, headerMime) {
  if (headerMime && headerMime !== 'application/octet-stream') return headerMime.split(';')[0];
  const ext = path.extname(String(urlOrName).split('?')[0]).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Save a buffer, return { file, url } — served at /media/:file until TTL. */
function saveMedia(buffer, mimeType, filename) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const file = `${crypto.randomBytes(16).toString('hex')}.${extFor(mimeType, filename)}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buffer);
  return { file, url: `${process.env.BACKEND_URL || ''}/media/${file}` };
}

/** Download a public URL (a GHL attachment) for re-sending on WhatsApp. */
async function fetchMedia(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', maxContentLength: MAX_DOWNLOAD, timeout: 60_000 });
  const buffer = Buffer.from(res.data);
  const nameFromUrl = decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'file');
  return { buffer, mimeType: mimeFor(url, res.headers['content-type']), filename: nameFromUrl };
}

function cleanupExpiredMedia() {
  try {
    if (!fs.existsSync(MEDIA_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, f);
      if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
    }
  } catch (err) {
    console.warn(`[Media] cleanup failed: ${err.message}`);
  }
}

function createMediaRouter() {
  const router = Router();
  router.get('/:file', (req, res) => {
    const file = path.basename(req.params.file);
    if (!/^[a-f0-9]{32}\.[a-z0-9]{1,5}$/.test(file)) return res.status(404).end();
    const p = path.join(MEDIA_DIR, file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(p);
  });
  return router;
}

module.exports = { saveMedia, fetchMedia, mimeFor, cleanupExpiredMedia, createMediaRouter };
