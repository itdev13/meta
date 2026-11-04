import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { Skeleton } from './ui';
import { routingApi } from '../lib/api-routing';
import { formatPhone } from '../lib/format';

/** Used until (or if) the explainer endpoint answers — same order and copy as the backend. */
const FALLBACK_STEPS = [
  { key: 'explicit', title: 'Workflow picks a number', description: 'A workflow action with a “Send from” number always wins. Use the number’s #, its phone, or its id.', example: 'Send from: WA#2' },
  { key: 'override', title: 'Override in the message', description: 'Put {WA#n} anywhere in your message to send it from WhatsApp #n. The code is removed before the customer sees it.', example: '{WA#2}' },
  { key: 'tag', title: 'Contact tag', description: 'Tag a contact with wa: followed by one of your linked phone numbers, and every reply to them goes from that number.', example: 'wa: +15551234567' },
  { key: 'assigned_user', title: 'Contact’s assigned user', description: 'If the contact is assigned to a team member, replies go from the number assigned to that person.', example: 'Contact → Assigned user → Number' },
  { key: 'sender', title: 'Who clicked send', description: 'Otherwise, the number assigned to the team member sending the message is used.', example: 'You → Your number' },
  { key: 'last_used', title: 'Same number as last time', description: 'Keeps the conversation on the number this contact last wrote to or heard from.', example: 'Last conversation' },
  { key: 'default', title: 'Default number', description: 'Falls back to your default number, then to whichever connected number was active most recently.', example: 'Default ★' },
];

const STEP_ICON = {
  explicit: 'zap',
  override: 'message',
  tag: 'key',
  assigned_user: 'users',
  sender: 'send',
  last_used: 'refresh',
  default: 'star',
};

const OPEN_KEY = 'wa.rt.open';

function readOpen() {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

function writeOpen(v) {
  try {
    window.localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* storage blocked in the CRM iframe — fine */
  }
}

/** Clipboard API → execCommand fallback. Resolves true when the text was copied. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked by iframe permissions — try the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function selectNode(node) {
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* nothing more we can do */
  }
}

function CopyToken({ token }) {
  const [state, setState] = useState('idle'); // idle | copied | manual
  const codeRef = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    const ok = await copyText(token);
    if (!ok) selectNode(codeRef.current);
    setState(ok ? 'copied' : 'manual');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1600 : 4000);
  };

  return (
    <span className="rt-copy">
      <code ref={codeRef} className="rt-token">
        {token}
      </code>
      <button type="button" className={`rt-copy-btn ${state}`} onClick={onCopy} title={`Copy ${token}`} aria-label={`Copy ${token}`}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
        <span>{state === 'copied' ? 'Copied' : state === 'manual' ? 'Press ⌘/Ctrl+C' : 'Copy'}</span>
      </button>
    </span>
  );
}

export default function NumberSelectionPanel({ locationId, numbers = [] }) {
  const [open, setOpen] = useState(readOpen);
  const [steps, setSteps] = useState(null);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!locationId) return undefined;
    let alive = true;
    const api = routingApi(locationId);
    api
      .explainer()
      .then((d) => alive && setSteps(Array.isArray(d?.steps) && d.steps.length ? d.steps : FALLBACK_STEPS))
      .catch(() => alive && setSteps(FALLBACK_STEPS));
    api
      .users()
      .then((d) => alive && setUsers(Array.isArray(d) ? d : []))
      .catch(() => alive && setUsers([]));
    return () => {
      alive = false;
    };
  }, [locationId]);

  const userName = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);

  const live = useMemo(
    () =>
      (numbers || [])
        .filter((n) => n.status === 'connected')
        .sort((a, b) => (a.index || 999) - (b.index || 999)),
    [numbers],
  );
  const offlineCount = (numbers || []).filter((n) => n.status !== 'connected').length;
  const sampleIndex = live[1]?.index || live[0]?.index || 2;
  const samplePhone = live[0]?.phoneNumber || '+15551234567';

  const toggle = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };

  const exampleFor = (s) => {
    if (s.key === 'override') return `{WA#${sampleIndex}}`;
    if (s.key === 'explicit') return `Send from: WA#${sampleIndex}`;
    if (s.key === 'tag') return `wa: ${samplePhone}`;
    return s.example;
  };

  return (
    <section className={`card rt-panel ${open ? 'open' : ''}`}>
      <button type="button" className="rt-head" onClick={toggle} aria-expanded={open}>
        <span className="rt-head-ic">
          <Icon name="sliders" size={17} />
        </span>
        <span className="rt-head-text">
          <span className="rt-title">Number selection</span>
          <span className="rt-sub">Which number each reply is sent from — the first rule that matches wins.</span>
        </span>
        {live.length > 0 && (
          <span className="rt-head-count">
            {live.length} live {live.length === 1 ? 'number' : 'numbers'}
          </span>
        )}
        <span className="rt-chev">
          <Icon name="chevron" size={16} />
        </span>
      </button>

      {open && (
        <div className="rt-body">
          <div className="rt-steps-col">
            {!steps ? (
              <div className="rt-skel">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} h={46} r={10} />
                ))}
              </div>
            ) : (
              <ol className="rt-steps">
                {steps.map((s, i) => (
                  <li key={s.key} className={`rt-step rt-k-${s.key}`}>
                    <span className="rt-num">{i + 1}</span>
                    <div className="rt-step-main">
                      <div className="rt-step-top">
                        <span className="rt-step-title">
                          <Icon name={STEP_ICON[s.key] || 'bolt'} size={14} />
                          {s.title}
                        </span>
                        <span className="rt-chip">{exampleFor(s)}</span>
                      </div>
                      <p className="rt-step-desc">{s.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="rt-foot">
              <Icon name="info" size={13} /> Only connected numbers are used. If a rule points at a number that is offline, the next rule decides. Group chats always reply from a number that is in the group.
            </p>
          </div>

          <aside className="rt-numbers">
            <div className="rt-numbers-head">
              <span>Your numbers</span>
              <span className="muted">use the # in {'{WA#n}'}</span>
            </div>
            {live.length === 0 ? (
              <div className="rt-empty">
                <Icon name="phone" size={18} />
                <span>No number is connected yet. Link one above and it will appear here with its #.</span>
              </div>
            ) : (
              <ul className="rt-list">
                {live.map((n) => {
                  const assigned = (n.assignedUserIds || []).map((id) => userName[id]).filter(Boolean);
                  return (
                    <li key={n.id} className="rt-row">
                      <span className="rt-idx">#{n.index || '?'}</span>
                      <div className="rt-row-main">
                        <div className="rt-row-name">
                          {n.name || `WhatsApp #${n.index}`}
                          {n.phoneNumber && <span className="rt-row-phone"> · {formatPhone(n.phoneNumber)}</span>}
                          {n.isDefault && (
                            <span className="rt-default" title="Default number">
                              <Icon name="star" size={11} /> Default
                            </span>
                          )}
                        </div>
                        <div className="rt-row-meta">
                          {assigned.length ? (
                            <>
                              <Icon name="users" size={12} /> {assigned.join(', ')}
                            </>
                          ) : (n.assignedUserIds || []).length ? (
                            <>
                              <Icon name="users" size={12} /> {n.assignedUserIds.length} assigned {n.assignedUserIds.length === 1 ? 'user' : 'users'}
                            </>
                          ) : (
                            <span className="muted">No users assigned</span>
                          )}
                        </div>
                      </div>
                      {n.index ? <CopyToken token={`{WA#${n.index}}`} /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {offlineCount > 0 && (
              <div className="rt-offline">
                {offlineCount} offline {offlineCount === 1 ? 'number is' : 'numbers are'} skipped until reconnected.
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
