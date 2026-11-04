const APP_NAME = process.env.APP_NAME || 'WhatsApp Connector';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Branded page shown after the marketplace OAuth redirect. */
function renderInstallPage({ kind, agency = false, already = false, message = '' }) {
  const ok = kind === 'success';
  const title = ok ? (already ? 'Already connected' : 'Installed successfully') : 'Installation failed';
  const steps = agency
    ? [
        'Open <b>Agency view → ' + APP_NAME + '</b> in the left menu',
        'Choose which sub-accounts may use WhatsApp',
        'Link numbers yourself, or let each sub-account scan its own QR code',
      ]
    : [
        'Open your sub-account and find <b>' + APP_NAME + '</b> in the left menu',
        'Click <b>Link a number</b> and scan the QR code with WhatsApp on your phone',
        'Replies from Conversations now go out on WhatsApp',
      ];

  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · ${APP_NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:Inter,system-ui,sans-serif;background:radial-gradient(900px 500px at 100% -10%,rgba(37,211,102,.18),transparent 55%),
radial-gradient(800px 500px at -10% 110%,rgba(7,94,84,.22),transparent 55%),#06231f;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:460px;background:#fff;border-radius:22px;padding:40px 36px;box-shadow:0 30px 70px -20px rgba(0,0,0,.5);text-align:center}
.badge{width:68px;height:68px;border-radius:20px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center}
.badge svg{width:34px;height:34px}h1{margin:0 0 8px;font-size:24px;font-weight:800;letter-spacing:-.02em;color:#0b1f1c}
.sub{color:#5b6b68;font-size:14.5px;margin:0 0 24px;line-height:1.55}
.steps{text-align:left;background:#f3fbf6;border:1px solid #d3efdd;border-radius:14px;padding:16px 18px}
.step{display:flex;gap:11px;align-items:flex-start;color:#2f3d3b;font-size:14px;margin:10px 0;line-height:1.5}
.n{flex:none;width:21px;height:21px;border-radius:50%;background:#128c4a;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px;border-radius:12px;padding:12px 14px;word-break:break-word}
.foot{color:#8a9997;font-size:12.5px;margin-top:18px}
</style></head><body><div class="card">
<div class="badge" style="background:${ok ? '#e5f7ec' : '#fdecec'}">${
    ok
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#128c4a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.4" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>'
  }</div>
<h1>${title}</h1>
<p class="sub">${ok ? `${APP_NAME} is ${already ? 'already' : 'now'} connected${agency ? ' to your agency' : ''}.` : 'We could not finish installing. Please try again.'}</p>
${
  ok
    ? `<div class="steps">${steps.map((s, i) => `<div class="step"><span class="n">${i + 1}</span><span>${s}</span></div>`).join('')}</div>`
    : `<div class="err">${escapeHtml(message || 'Unknown error')}</div>`
}
<p class="foot">You can close this window.</p>
</div></body></html>`;
}

module.exports = { renderInstallPage, escapeHtml };
