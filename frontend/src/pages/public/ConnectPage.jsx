import { useCallback, useEffect, useRef, useState } from 'react';
import { publicConnect } from '../../lib/api-share';
import { formatPhone } from '../../lib/format';
import { Button, Spinner, useToast } from '../../components/ui';
import { Icon, WaGlyph } from '../../components/icons';

const POLL_MS = 2000;
const SLOW_POLL_MS = 6000;
const QR_REFRESH_S = 20;
const LINKING = new Set(['pending', 'qr', 'pairing', 'connecting', 'disconnected']);
const FAILED = new Set(['logged_out', 'banned', 'replaced', 'paused']);

const GONE_COPY = {
  LINK_EXPIRED: { icon: 'refresh', title: 'This link has expired', body: 'For your security, connect links only work for a limited time. Ask the person who sent it for a fresh one.' },
  LINK_REVOKED: { icon: 'lock', title: 'This link was turned off', body: 'The person who sent it has switched it off. Ask them for a new link if you still need to connect.' },
  LINK_USED: { icon: 'check', title: 'Already connected', body: 'This link has already been used to connect a WhatsApp number. You can close this page.' },
  LINK_INVALID: { icon: 'unlink', title: 'This link isn’t valid', body: 'It may have been copied incompletely. Check the full link, or ask the person who sent it for a new one.' },
};

function Clock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const PHONE_QUERY = '(max-width: 640px), (hover: none) and (pointer: coarse) and (max-width: 900px)';

function useIsPhone() {
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const h = () => setM(mq.matches);
    mq.addEventListener?.('change', h);
    return () => mq.removeEventListener?.('change', h);
  }, []);
  return m;
}

/** Keep this page out of search engines and stop the token leaking via Referer. */
function usePrivatePage(title) {
  useEffect(() => {
    const add = (name, content) => {
      const el = document.createElement('meta');
      el.name = name;
      el.content = content;
      document.head.appendChild(el);
      return el;
    };
    const metas = [add('robots', 'noindex, nofollow, noarchive'), add('referrer', 'no-referrer')];
    return () => metas.forEach((el) => el.remove());
  }, []);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

function expiresIn(at) {
  if (!at) return '';
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `Expires in ${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `Expires in ${h} hour${h === 1 ? '' : 's'}`;
  return `Expires in ${Math.round(h / 24)} days`;
}

/**
 * Public "connect your WhatsApp" page opened from a share link (/connect/:token).
 * No CRM login: the token is the credential. Polls the server every 2s while linking.
 */
export default function ConnectPage({ token }) {
  const api = useRef(publicConnect(token)).current;
  const isPhone = useIsPhone();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [gone, setGone] = useState(null); // { code, message }
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState('setup'); // setup | linking
  const [method, setMethod] = useState(isPhone ? 'code' : 'qr');
  const [methodTouched, setMethodTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [qrAge, setQrAge] = useState(0);
  const lastQr = useRef(null);
  const slow = useRef(false);

  usePrivatePage(data?.businessName ? `Connect WhatsApp · ${data.businessName}` : 'Connect WhatsApp');

  // Phone-first default until the visitor picks a method themselves.
  useEffect(() => {
    if (!methodTouched && mode === 'setup') setMethod(isPhone ? 'code' : 'qr');
  }, [isPhone, methodTouched, mode]);

  const absorb = useCallback((d) => {
    if (d.qr && d.qr !== lastQr.current) {
      lastQr.current = d.qr;
      setQrAge(0);
    }
    setData((prev) => ({ ...d, qr: d.status === 'qr' ? d.qr || prev?.qr || null : null }));
  }, []);

  const fail = useCallback((err) => {
    if (err.status === 410) {
      setGone({ code: err.code || 'LINK_INVALID', message: err.message });
      return true;
    }
    if (err.status === 429) slow.current = true;
    return false;
  }, []);

  const load = useCallback(
    async (first) => {
      try {
        const d = await api.get();
        slow.current = false;
        setLoadError('');
        absorb(d);
        if (first) {
          if (LINKING.has(d.status) && d.method) {
            setMethod(d.method);
            setMethodTouched(true);
            setMode('linking');
          }
        }
        return d;
      } catch (err) {
        if (!fail(err) && first) setLoadError(err.message);
        return null;
      }
    },
    [api, absorb, fail],
  );

  useEffect(() => {
    load(true);
  }, [load]);

  // Poll while a link attempt is running (and briefly confirm the final state).
  const status = data?.status;
  useEffect(() => {
    if (gone || mode !== 'linking' || status === 'connected') return undefined;
    let alive = true;
    let t;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState !== 'hidden') await load(false);
      if (alive) t = setTimeout(tick, slow.current ? SLOW_POLL_MS : POLL_MS);
    };
    t = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [gone, mode, status, load]);

  useEffect(() => {
    if (status !== 'qr') return undefined;
    const t = setInterval(() => setQrAge((a) => Math.min(QR_REFRESH_S, a + 1)), 1000);
    return () => clearInterval(t);
  }, [status]);

  const start = async (m = method) => {
    setError('');
    setBusy(true);
    try {
      const d = await api.start({ method: m, phone: m === 'code' ? phone : undefined });
      lastQr.current = null;
      setQrAge(0);
      absorb(d);
      setMethod(m);
      setMode('linking');
    } catch (err) {
      if (!fail(err)) setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    setError('');
    setMode('setup');
    try {
      absorb(await api.cancel());
    } catch (err) {
      fail(err);
    }
  };

  const business = data?.businessName || '';

  let body;
  if (gone) body = <GoneState gone={gone} />;
  else if (!data && loadError) {
    body = (
      <StateCard icon="alert" tone="err" title="We couldn’t open this link">
        <p>{loadError}</p>
        <Button variant="primary" onClick={() => load(true)} icon="refresh">
          Try again
        </Button>
      </StateCard>
    );
  } else if (!data) {
    body = (
      <div className="sh-card sh-loading">
        <Spinner large />
      </div>
    );
  } else if (status === 'connected') body = <Connected data={data} />;
  else if (mode === 'setup') {
    body = (
      <Setup
        data={data}
        isPhone={isPhone}
        method={method}
        setMethod={(m) => {
          setMethod(m);
          setMethodTouched(true);
          setError('');
        }}
        phone={phone}
        setPhone={setPhone}
        busy={busy}
        error={error}
        onStart={() => start()}
      />
    );
  } else {
    body = (
      <Linking
        data={data}
        method={method}
        isPhone={isPhone}
        phone={phone}
        qrAge={qrAge}
        busy={busy}
        error={error}
        onRetry={() => start(method)}
        onBack={back}
        onCopy={(code) => navigator.clipboard?.writeText(code.replace('-', '')).then(() => toast('Code copied'), () => {})}
      />
    );
  }

  return (
    <div className="sh-page">
      <header className="sh-head">
        <div className="sh-brand">
          <div className="brandmark sh-mark">
            <WaGlyph size={20} />
          </div>
          <div>
            <div className="sh-brand-name">Greenline for WhatsApp</div>
            {business && !gone && <div className="sh-brand-sub">for {business}</div>}
          </div>
        </div>
        <div className="sh-secure">
          <Icon name="lock" size={13} /> Secure link
        </div>
      </header>
      <main className="sh-main">{body}</main>
      <footer className="sh-foot">
        Your phone stays the primary device. You can unlink anytime from WhatsApp → <b>Linked devices</b>.
      </footer>
    </div>
  );
}

function Setup({ data, isPhone, method, setMethod, phone, setPhone, busy, error, onStart }) {
  const business = data.businessName || 'Your business';
  const retryNote = data.status === 'qr_expired' || FAILED.has(data.status) ? data.lastError : '';
  const phoneOk = phone.replace(/[^\d]/g, '').length >= 8;
  return (
    <div className="sh-card">
      <div className="sh-hero">
        <div className="sh-hero-ic">
          <WaGlyph size={28} />
        </div>
        <h1>Connect your WhatsApp</h1>
        <p>
          <b>{business}</b> has invited you to link a WhatsApp number{data.label ? <> for <span className="sh-chip">{data.label}</span></> : null}. It takes
          about a minute.
        </p>
      </div>

      <div className="sh-methods" role="radiogroup" aria-label="How would you like to link?">
        <MethodOption
          active={method === 'code'}
          onClick={() => setMethod('code')}
          icon="key"
          title="Use phone number"
          desc="Get an 8-character code to type into WhatsApp."
          badge={isPhone ? 'Best on this phone' : null}
        />
        <MethodOption
          active={method === 'qr'}
          onClick={() => setMethod('qr')}
          icon="qr"
          title="Scan a QR code"
          desc={isPhone ? 'Needs a second screen to scan from.' : 'Scan this screen with your phone.'}
          badge={!isPhone ? 'Fastest' : null}
        />
      </div>

      {method === 'code' && (
        <div className="sh-field">
          <label htmlFor="sh-phone">Your WhatsApp number</label>
          <input
            id="sh-phone"
            className="input mono sh-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+1 415 555 0132"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && phoneOk && !busy && onStart()}
          />
          <div className="sh-hint">Include your country code — the number you use WhatsApp with.</div>
        </div>
      )}

      {method === 'qr' && isPhone && (
        <div className="sh-note">
          <Icon name="info" size={16} />
          <span>
            You can’t scan a QR code with the same phone that shows it. Open this link on a computer or tablet, or use your phone number instead.
          </span>
        </div>
      )}

      {retryNote && (
        <div className="sh-note warn">
          <Icon name="refresh" size={16} />
          <span>{retryNote} Start again below.</span>
        </div>
      )}
      {error && (
        <div className="sh-note err" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}

      <Button
        variant="primary"
        size="lg"
        className="sh-cta"
        loading={busy}
        disabled={method === 'code' && !phoneOk}
        onClick={onStart}
        icon={method === 'qr' ? 'qr' : 'key'}
      >
        {method === 'qr' ? 'Show QR code' : 'Get my pairing code'}
      </Button>

      <ul className="sh-trust">
        <li>
          <Icon name="shield" size={14} /> Messages sync securely with {business}’s inbox
        </li>
        <li>
          <Clock /> {expiresIn(data.expiresAt)}
        </li>
      </ul>
    </div>
  );
}

function MethodOption({ active, onClick, icon, title, desc, badge }) {
  return (
    <button type="button" role="radio" aria-checked={active} className={`sh-method ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="sh-method-ic">
        <Icon name={icon} size={18} />
      </span>
      <span className="sh-method-txt">
        <span className="t">
          {title}
          {badge && <span className="sh-badge">{badge}</span>}
        </span>
        <span className="d">{desc}</span>
      </span>
      <span className="sh-radio" aria-hidden />
    </button>
  );
}

function Steps({ method }) {
  return (
    <ol className="connect-steps sh-steps">
      <li>
        <span>
          Open <b>WhatsApp</b> on the phone with the number you want to connect
        </span>
      </li>
      <li>
        <span>
          Tap <span className="kbd">⋮ Menu</span> on Android or <span className="kbd">Settings</span> on iPhone
        </span>
      </li>
      <li>
        <span>
          Tap <b>Linked devices</b> → <b>Link a device</b>
        </span>
      </li>
      {method === 'qr' ? (
        <li>
          <span>Point your phone at the QR code to scan it</span>
        </li>
      ) : (
        <li>
          <span>
            Tap <b>Link with phone number instead</b> and type the code shown here
          </span>
        </li>
      )}
    </ol>
  );
}

function Linking({ data, method, isPhone, phone, qrAge, busy, error, onRetry, onBack, onCopy }) {
  const s = data.status;
  const expired = s === 'qr_expired' || s === 'ready';
  const failed = FAILED.has(s);
  const waiting = !expired && !failed && !(method === 'qr' ? s === 'qr' && data.qr : s === 'pairing' && data.pairingCode);

  const veil = (expired || failed || waiting) && (
    <div className={method === 'qr' ? 'qr-veil' : 'sh-veil'}>
      {expired || failed ? (
        <>
          <Icon name={failed ? 'alert' : 'refresh'} size={26} style={{ color: failed ? 'var(--err)' : 'var(--ink-3)' }} />
          <div>
            <b>{failed ? 'Linking didn’t finish' : 'Code expired'}</b>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {data.lastError || (failed ? 'Please try again.' : 'Nobody scanned it in time.')}
            </div>
          </div>
          <Button variant="primary" size="sm" loading={busy} onClick={onRetry} icon="refresh">
            {method === 'qr' ? 'New QR code' : 'New pairing code'}
          </Button>
        </>
      ) : (
        <>
          <Spinner large />
          <div className="muted" style={{ fontSize: 13 }}>
            {s === 'connecting' ? 'Linked — finishing setup…' : method === 'qr' ? 'Generating your QR code…' : 'Requesting your pairing code…'}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="sh-card sh-linking">
      <div className="sh-linking-head">
        <button type="button" className="sh-back" onClick={onBack}>
          <Icon name="chevron" size={15} style={{ transform: 'rotate(180deg)' }} /> Change method
        </button>
        <span className="sh-live">
          <span className="dot" /> Live
        </span>
      </div>

      <div className="sh-linking-grid">
        <div className="sh-code-col">
          {method === 'qr' ? (
            <>
              <div className="qr-frame sh-qr">
                {data.qr && s === 'qr' ? (
                  <>
                    <img src={data.qr} alt="WhatsApp link QR code" />
                    <div className="qr-logo">
                      <div>
                        <WaGlyph size={22} />
                      </div>
                    </div>
                  </>
                ) : null}
                {veil}
              </div>
              {s === 'qr' && (
                <>
                  <div className="qr-timer sh-timer">
                    <div style={{ width: `${100 - (qrAge / QR_REFRESH_S) * 100}%` }} />
                  </div>
                  <div className="sh-hint center">The code refreshes automatically</div>
                </>
              )}
              {isPhone && (
                <div className="sh-note" style={{ marginTop: 14 }}>
                  <Icon name="info" size={16} />
                  <span>Scan this from another phone screen, or go back and use your phone number.</span>
                </div>
              )}
            </>
          ) : (
            <div className="sh-pair">
              {s === 'pairing' && data.pairingCode ? (
                <>
                  <div className="section-title">Your pairing code</div>
                  <div className="pair-code sh-pair-code" aria-label={`Pairing code ${data.pairingCode}`}>
                    {data.pairingCode.split('').map((c, i) => (c === '-' ? <span key={i} className="sep">–</span> : <span key={i}>{c}</span>))}
                  </div>
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => onCopy(data.pairingCode)}>
                    Copy code
                  </Button>
                  {phone && <div className="sh-hint center">For {formatPhone(phone)}</div>}
                  <div className="sh-hint center">WhatsApp will also show a notification — tap it to enter the code.</div>
                </>
              ) : (
                veil
              )}
            </div>
          )}
        </div>
        <div className="sh-steps-col">
          <div className="sh-steps-title">How to link</div>
          <Steps method={method} />
        </div>
      </div>

      {error && (
        <div className="sh-note err" role="alert" style={{ marginTop: 16 }}>
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function Connected({ data }) {
  const business = data.businessName || 'the business';
  return (
    <div className="sh-card sh-done">
      <div className="success-burst">
        <Icon name="check" size={36} stroke={2.6} />
      </div>
      <h1>You’re connected</h1>
      {data.phoneNumber && <div className="sh-done-phone">{formatPhone(data.phoneNumber)}</div>}
      {data.waName && <div className="muted">{data.waName}</div>}
      <p>
        Your WhatsApp is now linked to <b>{business}</b>. New messages will sync with their inbox, and you keep using WhatsApp on your phone as usual.
      </p>
      <div className="sh-done-tip">
        <Icon name="check" size={14} /> You can safely close this page.
      </div>
    </div>
  );
}

function GoneState({ gone }) {
  const c = GONE_COPY[gone.code] || GONE_COPY.LINK_INVALID;
  return (
    <StateCard icon={c.icon} tone={gone.code === 'LINK_USED' ? 'ok' : 'muted'} title={c.title}>
      <p>{c.body}</p>
    </StateCard>
  );
}

function StateCard({ icon, tone = 'muted', title, children }) {
  return (
    <div className="sh-card sh-state">
      <div className={`sh-state-ic ${tone}`}>
        <Icon name={icon} size={24} />
      </div>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
