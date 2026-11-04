const LOGO = require('./logo-data-uri');

const BRAND = process.env.APP_NAME || 'Greenline';
const MENU = process.env.APP_MENU_NAME || 'WhatsApp'; // the custom page title in the CRM's left menu
const COMPANY = process.env.APP_COMPANY || 'EnrichFlow Labs';
const SUPPORT = process.env.SUPPORT_EMAIL || '';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  toggle: '<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="16" cy="12" r="3"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.2 9.2 0 0 1-3.8-.8L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Branded page shown after the marketplace OAuth redirect. */
function renderInstallPage({ kind, agency = false, already = false, message = '' }) {
  const ok = kind === 'success';
  const title = ok ? (already ? 'You’re already connected' : 'You’re all set') : 'Installation didn’t finish';
  const sub = ok
    ? agency
      ? `${BRAND} is installed for your agency. Every sub-account can now get WhatsApp from one place.`
      : `${BRAND} is installed. Link your WhatsApp number and chats start landing in Conversations.`
    : 'Something interrupted the installation. Nothing was changed. Please try installing again.';

  const steps = agency
    ? [
        ['menu', `Open <b>${MENU}</b> in your agency’s left menu`, 'Your agency console lists every sub-account.'],
        ['toggle', 'Choose which sub-accounts get WhatsApp', 'Turn it on for everyone, or only for the clients you pick.'],
        ['qr', 'Link numbers', 'Scan the QR yourself, send a share link, or let clients scan their own.'],
      ]
    : [
        ['menu', `Open <b>${MENU}</b> in the sub-account’s left menu`, 'It sits with the rest of your apps.'],
        ['qr', 'Click <b>Link a number</b> and scan the QR', 'WhatsApp → Settings → Linked devices → Link a device.'],
        ['chat', 'Chat from Conversations', 'Replies, workflows and auto-replies now go out on WhatsApp.'],
      ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>${ok ? 'Installed' : 'Install error'} · ${BRAND} for WhatsApp</title>
<link rel="icon" href="${LOGO}"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box}
:root{--ink:#0e1b18;--ink2:#4a5a55;--ink3:#7b8a85;--line:#e3e9e5;--brand:#10883f;--brand2:#25d366;--soft:#ecf8f1}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;
  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;
  background:radial-gradient(1000px 560px at 85% -10%,rgba(37,211,102,.22),transparent 60%),
             radial-gradient(800px 520px at -10% 110%,rgba(16,136,63,.28),transparent 60%),#06231f}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px;color:#fff}
.brand img{width:40px;height:40px;border-radius:12px;box-shadow:0 8px 24px -8px rgba(37,211,102,.6)}
.brand b{font-size:17px;font-weight:800;letter-spacing:-.01em}
.brand span{font-size:17px;font-weight:500;opacity:.7}
.card{width:100%;max-width:520px;background:#fff;border-radius:24px;overflow:hidden;
  box-shadow:0 40px 90px -30px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.06) inset;animation:rise .55s cubic-bezier(.2,.8,.3,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.98)}}
.hero{padding:36px 36px 26px;text-align:center;background:linear-gradient(180deg,${ok ? '#f2fbf6' : '#fdf3f3'},#fff)}
.badge{width:76px;height:76px;margin:0 auto 18px;border-radius:24px;display:grid;place-items:center;position:relative;
  background:${ok ? 'linear-gradient(140deg,#22c55e,#0a6b34)' : 'linear-gradient(140deg,#f87171,#b91c1c)'};
  box-shadow:0 16px 36px -12px ${ok ? 'rgba(16,136,63,.65)' : 'rgba(185,28,28,.5)'};animation:pop .6s .15s cubic-bezier(.2,.9,.3,1.4) both}
.badge svg{width:38px;height:38px;color:#fff}
.badge::after{content:"";position:absolute;inset:-8px;border-radius:30px;border:2px solid ${ok ? 'rgba(34,197,94,.25)' : 'rgba(248,113,113,.25)'};animation:ring 1.6s .5s ease-out both}
@keyframes pop{from{transform:scale(.4) rotate(-12deg);opacity:0}}
@keyframes ring{from{transform:scale(.85);opacity:1}to{transform:scale(1.25);opacity:0}}
h1{margin:0 0 8px;font-size:26px;font-weight:800;letter-spacing:-.025em}
.sub{margin:0 auto;max-width:400px;color:var(--ink2);font-size:15px;line-height:1.55}
.body{padding:8px 32px 28px}
.label{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:6px 4px 10px}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.step{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#fff;
  animation:rise .5s both}
.step:nth-child(1){animation-delay:.25s}.step:nth-child(2){animation-delay:.35s}.step:nth-child(3){animation-delay:.45s}
.ic{flex:none;width:36px;height:36px;border-radius:11px;background:var(--soft);color:var(--brand);display:grid;place-items:center;position:relative}
.ic svg{width:18px;height:18px}
.ic i{position:absolute;top:-6px;left:-6px;width:18px;height:18px;border-radius:50%;background:var(--brand);color:#fff;font:700 10.5px/18px Inter,sans-serif;font-style:normal;text-align:center;box-shadow:0 0 0 2px #fff}
.t{font-weight:600;font-size:14.5px;line-height:1.4}.t b{font-weight:800;color:var(--brand)}
.d{color:var(--ink3);font-size:13px;margin-top:2px;line-height:1.45}
.err{margin:4px 0 0;padding:12px 14px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13.5px;line-height:1.5;word-break:break-word}
.actions{display:flex;gap:10px;justify-content:center;margin-top:22px;flex-wrap:wrap}
.btn{appearance:none;border:0;cursor:pointer;height:44px;padding:0 20px;border-radius:12px;font:600 14.5px Inter,sans-serif;
  display:inline-flex;align-items:center;gap:8px;text-decoration:none}
.btn-primary{background:var(--brand);color:#fff;box-shadow:0 8px 20px -8px rgba(16,136,63,.7)}
.btn-primary:hover{background:#0c7536}
.btn-ghost{background:#f1f4f2;color:var(--ink)}
.hint{text-align:center;color:var(--ink3);font-size:12.5px;margin-top:12px}
.foot{margin-top:22px;color:rgba(255,255,255,.55);font-size:12.5px;text-align:center}
.foot a{color:rgba(255,255,255,.8)}
@media (max-width:520px){.hero{padding:30px 22px 20px}.body{padding:6px 18px 22px}h1{font-size:23px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body>
<div class="brand"><img src="${LOGO}" alt=""/><b>${BRAND}</b><span>for WhatsApp</span></div>
<main class="card">
  <section class="hero">
    <div class="badge">${
      ok
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6M12 16.5v.5"/></svg>'
    }</div>
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
  </section>
  <section class="body">
    ${
      ok
        ? `<div class="label">Next steps</div><ol class="steps">${steps
            .map(([ic, t, d], i) => `<li class="step"><span class="ic">${icon(ic)}<i>${i + 1}</i></span><div><div class="t">${t}</div><div class="d">${d}</div></div></li>`)
            .join('')}</ol>`
        : `<div class="err">${escapeHtml(message || 'Unknown error')}</div>`
    }
    <div class="actions">
      <button class="btn btn-primary" onclick="window.close();this.textContent='You can close this tab now'">${ok ? 'Done, close this tab' : 'Close and try again'}</button>
    </div>
    <div class="hint">${ok ? `Back in your CRM, open <b>${MENU}</b> in the left menu.` : 'Then start the installation again from the marketplace.'}</div>
  </section>
</main>
<div class="foot">${BRAND} for WhatsApp · by ${COMPANY}${SUPPORT ? ` · <a href="mailto:${escapeHtml(SUPPORT)}">${escapeHtml(SUPPORT)}</a>` : ''}<br/>Not affiliated with WhatsApp or Meta.</div>
</body></html>`;
}

module.exports = { renderInstallPage, escapeHtml };
