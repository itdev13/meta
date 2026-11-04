import { useEffect, useRef, useState } from 'react';
import { loc } from '../lib/api';
import { useLiveStatus } from '../lib/live';
import { formatPhone } from '../lib/format';
import { Button, Field, Modal, Segmented, Spinner, useToast } from './ui';
import { Icon, WaGlyph } from './icons';

const QR_REFRESH_S = 20;
const FAIL_STATES = { logged_out: true, banned: true, replaced: true };

/**
 * Link (or re-link) a WhatsApp number to a sub-account.
 *   setup   → choose QR or pairing code (+ optional label)
 *   linking → live QR / pairing code streamed from the server, auto-refreshing
 *   done    → success + optional test message
 */
export default function ConnectNumberModal({ locationId, locationName, relink, onClose, onLinked }) {
  const api = loc(locationId);
  const toast = useToast();
  const [step, setStep] = useState('setup');
  const [method, setMethod] = useState('qr');
  const [label, setLabel] = useState(relink?.label || '');
  const [phone, setPhone] = useState(relink?.phoneNumber || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [s, setS] = useState(null); // { id, status, qr, pairingCode, phoneNumber, waName, lastError }
  const [qrAge, setQrAge] = useState(0);
  const idRef = useRef(null);
  const doneRef = useRef(false);

  const apply = (patch) => {
    setS((prev) => {
      const next = { ...(prev || {}), ...patch };
      // keep the last QR visible until a new one arrives (status events can omit it)
      if (patch.status === 'qr' && !patch.qr) next.qr = prev?.qr;
      if (patch.qr && patch.qr !== prev?.qr) setQrAge(0);
      return next;
    });
    if (patch.status === 'connected' && !doneRef.current) {
      doneRef.current = true;
      setStep('done');
      onLinked?.();
    }
  };

  useLiveStatus((evt) => {
    if (evt.sessionId === idRef.current) apply(evt);
  });

  // Fallback poll (proxies that buffer SSE) — cheap, every 4s while linking.
  useEffect(() => {
    if (step !== 'linking') return undefined;
    const t = setInterval(async () => {
      try {
        const list = await api.numbers();
        const me = list.find((n) => n.id === idRef.current);
        if (me) apply({ status: me.status, ...(me.qr ? { qr: me.qr } : {}), pairingCode: me.pairingCode, phoneNumber: me.phoneNumber, waName: me.waName, lastError: me.lastError });
      } catch {
        /* ignore */
      }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (s?.status !== 'qr') return undefined;
    const t = setInterval(() => setQrAge((a) => Math.min(QR_REFRESH_S, a + 1)), 1000);
    return () => clearInterval(t);
  }, [s?.status]);

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      const body = { label, method, phone: method === 'code' ? phone : undefined };
      const res = relink?.id || idRef.current ? await api.relink(relink?.id || idRef.current, body) : await api.link(body);
      idRef.current = res.id;
      doneRef.current = false;
      setS(res);
      setQrAge(0);
      setStep('linking');
      if (res.status === 'connected') apply(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (idRef.current && step === 'linking' && s?.status !== 'connected') {
      api.cancel(idRef.current).catch(() => {});
    }
    onClose();
  };

  const title = step === 'done' ? 'Number linked' : relink ? 'Re-link WhatsApp number' : 'Link a WhatsApp number';
  const subtitle = step === 'done' ? null : locationName ? `For ${locationName}` : 'Messages sync both ways with Conversations.';

  return (
    <Modal title={title} subtitle={subtitle} onClose={close} wide={step === 'linking'}>
      {step === 'setup' && (
        <div className="stack" style={{ gap: 18 }}>
          <Segmented
            value={method}
            onChange={setMethod}
            options={[
              { value: 'qr', label: 'Scan QR code', icon: 'qr' },
              { value: 'code', label: 'Use phone number', icon: 'key' },
            ]}
          />
          <Field label="Label (optional)" hint="Shown to your team, e.g. “Sales line” or “Support”.">
            <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Sales line" />
          </Field>
          {method === 'code' && (
            <Field label="WhatsApp phone number" hint="Include the country code. You’ll get an 8-character code to type into WhatsApp.">
              <input className="input mono" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 415 555 0132" inputMode="tel" />
            </Field>
          )}
          <div className="banner warn" style={{ margin: 0 }}>
            <div className="ic">
              <Icon name="shield" size={17} />
            </div>
            <div className="d">
              Use a number you already chat from. WhatsApp can restrict numbers that send bulk or unsolicited messages — sends are paced
              automatically to keep your number safe.
            </div>
          </div>
          {error && <div className="banner err" style={{ margin: 0 }}><div className="ic"><Icon name="alert" size={17} /></div><div className="d">{error}</div></div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={start} icon={method === 'qr' ? 'qr' : 'key'}>
              {method === 'qr' ? 'Show QR code' : 'Get pairing code'}
            </Button>
          </div>
        </div>
      )}

      {step === 'linking' && (
        <div className="connect-grid">
          <div className="stack" style={{ gap: 18 }}>
            <ol className="connect-steps">
              <li>
                <span>
                  Open <b>WhatsApp</b> on the phone with the number you want to link
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
                  <span>Point your phone at this screen to scan the code</span>
                </li>
              ) : (
                <li>
                  <span>
                    Tap <b>Link with phone number instead</b> and enter the code shown here
                  </span>
                </li>
              )}
            </ol>
            <div className="row muted" style={{ fontSize: 12.5 }}>
              <Icon name="lock" size={14} /> Your phone stays the primary device. You can unlink anytime from WhatsApp or here.
            </div>
          </div>

          <div>
            {method === 'qr' ? (
              <>
                <div className="qr-frame">
                  {s?.qr && s.status === 'qr' ? (
                    <>
                      <img src={s.qr} alt="WhatsApp link QR code" />
                      <div className="qr-logo">
                        <div>
                          <WaGlyph size={22} />
                        </div>
                      </div>
                    </>
                  ) : null}
                  <LinkVeil s={s} onRetry={start} busy={busy} waitingLabel="Generating QR code…" />
                </div>
                {s?.status === 'qr' && (
                  <>
                    <div className="qr-timer">
                      <div style={{ width: `${100 - (qrAge / QR_REFRESH_S) * 100}%` }} />
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6, textAlign: 'center' }}>
                      The code refreshes automatically
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="card card-pad" style={{ width: 320, maxWidth: '100%', minHeight: 220, position: 'relative', display: 'grid', placeItems: 'center' }}>
                {s?.pairingCode && s.status === 'pairing' ? (
                  <div style={{ textAlign: 'center' }}>
                    <div className="section-title">Your pairing code</div>
                    <div className="pair-code">
                      {s.pairingCode.split('').map((c, i) => (c === '-' ? <span key={i} className="sep">–</span> : <span key={i}>{c}</span>))}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="copy"
                      onClick={() => {
                        navigator.clipboard?.writeText(s.pairingCode.replace('-', '')).then(() => toast('Code copied'), () => {});
                      }}
                    >
                      Copy code
                    </Button>
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      Sent for {formatPhone(phone)}
                    </div>
                  </div>
                ) : (
                  <LinkVeil s={s} onRetry={start} busy={busy} waitingLabel="Requesting a pairing code…" plain />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'done' && <Linked s={s} locationId={locationId} onClose={onClose} />}
    </Modal>
  );
}

function LinkVeil({ s, onRetry, busy, waitingLabel, plain }) {
  const status = s?.status;
  if (status === 'qr' || status === 'pairing') return null;
  let body;
  if (status === 'qr_expired') {
    body = (
      <>
        <Icon name="refresh" size={26} style={{ color: 'var(--ink-3)' }} />
        <div>
          <b>Code expired</b>
          <div className="muted" style={{ fontSize: 13 }}>
            {s.lastError || 'Nobody scanned it in time.'}
          </div>
        </div>
        <Button variant="primary" size="sm" loading={busy} onClick={onRetry}>
          Generate new code
        </Button>
      </>
    );
  } else if (FAIL_STATES[status]) {
    body = (
      <>
        <Icon name="alert" size={26} style={{ color: 'var(--err)' }} />
        <div className="muted" style={{ fontSize: 13 }}>
          {s.lastError || 'Linking failed.'}
        </div>
        <Button variant="secondary" size="sm" loading={busy} onClick={onRetry}>
          Try again
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <Spinner large />
        <div className="muted" style={{ fontSize: 13 }}>
          {status === 'connecting' && s?.qr ? 'Scanned — finishing setup…' : waitingLabel}
        </div>
      </>
    );
  }
  return plain ? <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>{body}</div> : <div className="qr-veil">{body}</div>;
}

function Linked({ s, locationId, onClose }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const sendTest = async () => {
    setSending(true);
    try {
      await loc(locationId).test(s.id || s.sessionId, { phone: to });
      toast('Test message sent');
      setTo('');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setSending(false);
    }
  };
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="success-burst">
        <Icon name="check" size={36} stroke={2.6} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: '-0.02em' }}>{formatPhone(s?.phoneNumber) || 'WhatsApp connected'}</div>
      {s?.waName && <div className="muted">{s.waName}</div>}
      <p className="muted" style={{ margin: '12px auto 20px', maxWidth: 400 }}>
        New WhatsApp messages now appear in Conversations, and replies sent there go out from this number.
      </p>
      <div className="card card-pad" style={{ textAlign: 'left', background: 'var(--surface-2)' }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Send a test message</div>
        <div className="row">
          <input className="input mono grow" placeholder="+1 415 555 0132" value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" />
          <Button icon="send" loading={sending} disabled={!to.trim()} onClick={sendTest}>
            Send
          </Button>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
        <Button variant="primary" size="lg" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
