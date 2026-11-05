import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';

const fmtCache = new Map();
function zoneFmt(tz) {
  if (!fmtCache.has(tz)) {
    try {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' }));
    } catch {
      fmtCache.set(tz, null);
    }
  }
  return fmtCache.get(tz);
}

/** { city, region, offset: 'GMT-8', time: '9:41 AM' } for an IANA zone. */
export function describeZone(tz, now = new Date()) {
  const parts = tz.split('/');
  const city = (parts[parts.length - 1] || tz).replace(/_/g, ' ');
  const region = parts.length > 1 ? parts.slice(0, -1).join(' / ').replace(/_/g, ' ') : '';
  const f = zoneFmt(tz);
  let offset = '';
  let time = '';
  if (f) {
    const p = f.formatToParts(now);
    offset = (p.find((x) => x.type === 'timeZoneName')?.value || '').replace(/^GMT$/, 'GMT+0');
    time = p
      .filter((x) => ['hour', 'minute', 'literal', 'dayPeriod'].includes(x.type))
      .map((x) => x.value)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return { city, region, offset, time };
}

/**
 * Searchable timezone combobox. value '' means "follow the default" (defaultLabel / defaultZone).
 * groups: [{ label, zones: [...] }]
 */
export default function TimezonePicker({ value, onChange, groups, defaultLabel = 'Sub-account timezone', defaultZone }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef(null);
  const input = useRef(null);
  const list = useRef(null);
  const now = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat, filtered option list: [{ kind:'head', label } | { kind:'opt', value, ...describeZone }]
  const items = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/[\s_]+/g, ' ');
    const match = (z) => {
      if (!term) return true;
      const d = describeZone(z, now);
      return `${z.replace(/_/g, ' ')} ${d.offset}`.toLowerCase().includes(term);
    };
    const out = [];
    if (!term || `${defaultLabel} ${defaultZone || ''}`.toLowerCase().includes(term)) {
      out.push({ kind: 'opt', value: '', isDefault: true, ...(defaultZone ? describeZone(defaultZone, now) : { city: 'UTC', region: '', offset: 'GMT+0', time: '' }) });
    }
    const seen = new Set();
    for (const g of groups) {
      const zones = g.zones.filter((z) => !seen.has(z) && match(z));
      zones.forEach((z) => seen.add(z));
      if (!zones.length) continue;
      out.push({ kind: 'head', label: g.label, count: zones.length });
      for (const z of zones) out.push({ kind: 'opt', value: z, ...describeZone(z, now) });
    }
    return out;
  }, [q, groups, defaultLabel, defaultZone, now]);

  const opts = items.filter((i) => i.kind === 'opt');

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    setTimeout(() => input.current?.focus(), 0);
    const sel = opts.findIndex((o) => o.value === value);
    setActive(sel < 0 ? 0 : sel);
    return () => document.removeEventListener('mousedown', h);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (v) => {
    onChange(v);
    setOpen(false);
    setQ('');
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, opts.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (opts[active]) choose(opts[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const cur = value ? describeZone(value, now) : defaultZone ? describeZone(defaultZone, now) : { city: 'UTC', region: '', offset: 'GMT+0', time: '' };
  let optIdx = -1;

  return (
    <div className={`tzp ${open ? 'open' : ''}`} ref={wrap}>
      <button type="button" className="tzp-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="tzp-globe">
          <Icon name="clock" size={15} />
        </span>
        <span className="tzp-main">
          <span className="tzp-city">
            {cur.city}
            {!value && <span className="tzp-tag">Sub-account default</span>}
          </span>
          <span className="tzp-sub">
            {[cur.region, cur.offset].filter(Boolean).join(' · ')}
          </span>
        </span>
        {cur.time && <span className="tzp-time">{cur.time}</span>}
        <span className="tzp-caret">
          <Icon name="chevron" size={15} />
        </span>
      </button>

      {open && (
        <div className="tzp-pop" role="listbox">
          <div className="tzp-search">
            <Icon name="search" size={15} />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search city, region or GMT+5:30" />
            {q && (
              <button type="button" className="tzp-clear" onClick={() => setQ('')} aria-label="Clear search">
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
          <div className="tzp-list" ref={list}>
            {opts.length === 0 && <div className="tzp-empty">No timezone matches “{q}”</div>}
            {items.map((it, i) => {
              if (it.kind === 'head') {
                return (
                  <div key={`h-${it.label}`} className="tzp-head">
                    {it.label}
                    <span>{it.count}</span>
                  </div>
                );
              }
              optIdx += 1;
              const idx = optIdx;
              const selected = it.value === value;
              return (
                <button
                  type="button"
                  key={`o-${it.value || 'default'}-${i}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={selected}
                  className={`tzp-opt ${idx === active ? 'active' : ''} ${selected ? 'selected' : ''} ${it.isDefault ? 'is-default' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(it.value)}
                >
                  <span className="tzp-opt-main">
                    <span className="tzp-opt-city">{it.isDefault ? defaultLabel : it.city}</span>
                    <span className="tzp-opt-region">{it.isDefault ? (defaultZone ? defaultZone.replace(/_/g, ' ') : 'Not set — uses UTC') : it.region}</span>
                  </span>
                  <span className="tzp-opt-off">{it.offset}</span>
                  <span className="tzp-opt-time">{it.time}</span>
                  <span className="tzp-opt-check">{selected && <Icon name="check" size={15} />}</span>
                </button>
              );
            })}
          </div>
          <div className="tzp-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> to move · <kbd>Enter</kbd> to pick
            </span>
            <span>{opts.length} zones</span>
          </div>
        </div>
      )}
    </div>
  );
}
