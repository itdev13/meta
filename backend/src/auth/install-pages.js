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
        ['menu', `Open <b>${MENU}</b> in your agency’s left menu`, 'The agency console lists every sub-account with the app installed.'],
        ['toggle', 'Switch WhatsApp on for your clients', 'It starts off for every sub-account, so you decide who gets it.'],
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
.card{width:100%;max-width:540px;background:#fff;border-radius:24px;overflow:hidden;
  box-shadow:0 40px 90px -30px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.06) inset;animation:rise .55s cubic-bezier(.2,.8,.3,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.98)}}
.hero{padding:40px 40px 28px;text-align:center;background:linear-gradient(180deg,${ok ? '#f2fbf6' : '#fdf3f3'},#fff)}
.badge{width:64px;height:64px;margin:0 auto 18px;border-radius:20px;display:grid;place-items:center;position:relative;
  background:${ok ? 'linear-gradient(140deg,#22c55e,#0a6b34)' : 'linear-gradient(140deg,#f87171,#b91c1c)'};
  box-shadow:0 14px 30px -12px ${ok ? 'rgba(16,136,63,.6)' : 'rgba(185,28,28,.5)'};animation:pop .6s .15s cubic-bezier(.2,.9,.3,1.4) both}
.badge svg{width:32px;height:32px;color:#fff}
.badge::after{content:"";position:absolute;inset:-7px;border-radius:26px;border:2px solid ${ok ? 'rgba(34,197,94,.25)' : 'rgba(248,113,113,.25)'};animation:ring 1.6s .5s ease-out both}
@keyframes pop{from{transform:scale(.4) rotate(-12deg);opacity:0}}
@keyframes ring{from{transform:scale(.85);opacity:1}to{transform:scale(1.25);opacity:0}}
h1{margin:0 0 8px;font-size:26px;font-weight:800;letter-spacing:-.025em;line-height:1.2}
.sub{margin:0 auto;max-width:380px;color:var(--ink2);font-size:15px;line-height:1.6}
.body{padding:4px 40px 32px}
.panel{background:#f6faf8;border:1px solid #e4efe9;border-radius:16px;padding:20px 22px}
.label{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:0 0 16px}
.steps{list-style:none;margin:0;padding:0}
.step{position:relative;display:grid;grid-template-columns:28px 1fr;column-gap:14px;padding-bottom:18px;animation:rise .5s both}
.step:last-child{padding-bottom:0}
.step:nth-child(1){animation-delay:.2s}.step:nth-child(2){animation-delay:.3s}.step:nth-child(3){animation-delay:.4s}
.step::before{content:"";position:absolute;left:13px;top:30px;bottom:2px;width:2px;border-radius:2px;background:#d4e9dc}
.step:last-child::before{display:none}
.num{width:28px;height:28px;border-radius:50%;background:var(--brand);color:#fff;font-weight:700;font-size:13px;display:grid;place-items:center;
  box-shadow:0 0 0 4px #e3f3e9}
.t{font-weight:600;font-size:15px;line-height:1.4;padding-top:3px}.t b{font-weight:700;color:var(--brand)}
.d{color:var(--ink3);font-size:13.5px;margin-top:3px;line-height:1.5}
.err{padding:14px 16px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:14px;line-height:1.55;word-break:break-word;text-align:center}
.actions{display:flex;justify-content:center;margin-top:26px}
.btn{appearance:none;border:0;cursor:pointer;height:46px;padding:0 24px;border-radius:12px;font:600 15px Inter,sans-serif;display:inline-flex;align-items:center;gap:8px}
.btn-primary{background:var(--brand);color:#fff;box-shadow:0 10px 22px -10px rgba(16,136,63,.75)}
.btn-primary:hover{background:#0c7536}
.hint{text-align:center;color:var(--ink3);font-size:13px;margin-top:12px;line-height:1.5}
.hint b{color:var(--ink2)}
.foot{margin-top:24px;color:rgba(255,255,255,.55);font-size:12.5px;text-align:center;line-height:1.7}
.foot a{color:rgba(255,255,255,.8)}
@media (max-width:520px){.hero{padding:32px 22px 22px}.body{padding:4px 18px 24px}.panel{padding:18px}h1{font-size:23px}}
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
        ? `<div class="panel"><div class="label">Next steps</div><ol class="steps">${steps
            .map(([, t, d], i) => `<li class="step"><span class="num">${i + 1}</span><div><div class="t">${t}</div><div class="d">${d}</div></div></li>`)
            .join('')}</ol></div>`
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
