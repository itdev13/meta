import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { initials, timeAgo } from '../lib/format';

export function Button({ variant = 'secondary', size, icon, loading, children, className = '', ...rest }) {
  return (
    <button className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, title, ...rest }) {
  return (
    <button className="icon-btn" title={title} aria-label={title} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function Pill({ tone = 'neutral', dot, live, children, title }) {
  return (
    <span className={`pill ${tone} ${live ? 'live' : ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Toggle({ on, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      className={`toggle ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
          {o.count != null && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Avatar({ name, src, size }) {
  return <div className={`avatar ${size === 'lg' ? 'lg' : ''}`}>{src ? <img src={src} alt="" /> : initials(name)}</div>;
}

export function Spinner({ large }) {
  return <span className={`spinner ${large ? 'lg' : ''}`} />;
}

export function Skeleton({ h = 16, w = '100%', r }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}

export function Empty({ icon = 'inbox', title, children, action }) {
  return (
    <div className="empty">
      <div className="ic">
        <Icon name={icon} size={22} />
      </div>
      <h4>{title}</h4>
      {children && <div style={{ maxWidth: 380, margin: '0 auto' }}>{children}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

// ── Page-level building blocks (sub-account pages; `lc-` styles) ──

/**
 * Page header: eyebrow · title · one-line description on the left; actions (and an optional
 * meta line under them, e.g. "Updated 2m ago · Refresh") right-aligned.
 */
export function PageHeader({ eyebrow, title, description, actions, meta }) {
  return (
    <header className="lc-head">
      <div className="lc-head-text">
        {eyebrow && <div className="lc-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {(actions || meta) && (
        <div className="lc-head-side">
          {actions && <div className="lc-head-actions">{actions}</div>}
          {meta && <div className="lc-head-meta">{meta}</div>}
        </div>
      )}
    </header>
  );
}

/** "● Updated 2m ago  ⟳" — freshness line with an inline refresh. */
export function SyncMeta({ at, loading, onRefresh, label = 'Updated' }) {
  return (
    <span className={`lc-sync ${loading ? 'is-loading' : ''}`}>
      <span className="lc-sync-dot" aria-hidden="true" />
      <span title={at ? new Date(at).toLocaleString() : undefined}>{loading ? 'Updating…' : at ? `${label} ${timeAgo(at)}` : 'Not loaded yet'}</span>
      {onRefresh && (
        <button type="button" className="lc-sync-btn" onClick={onRefresh} disabled={loading} aria-label="Refresh" title="Refresh">
          <Icon name="refresh" size={13} className={loading ? 'lc-spin' : undefined} />
          <span>Refresh</span>
        </button>
      )}
    </span>
  );
}

/** KPI tile with an icon chip (same language as the agency console). tone: brand | teal | info | violet | amber | calm | alert */
export function KpiTile({ label, value, unit, icon, hint, tone = 'brand', meter, aside, onClick, title }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`ag-kpi lc-kpi ${tone} ${onClick ? 'clickable' : ''}`} onClick={onClick || undefined} title={title}>
      <div className="ag-kpi-top">
        <span className="ag-kpi-ic">
          <Icon name={icon} size={15} />
        </span>
        <span className="ag-kpi-k">{label}</span>
        {onClick && <Icon name="chevron" size={14} className="ag-kpi-go" />}
      </div>
      <div className="lc-kpi-row">
        <div className="ag-kpi-v tnum">
          {value}
          {unit && <small>{unit}</small>}
        </div>
        {aside}
      </div>
      {meter != null && (
        <div className="ag-kpi-meter" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }} />
        </div>
      )}
      {hint && <div className="ag-kpi-h">{hint}</div>}
    </Tag>
  );
}

export function KpiGrid({ children, cols }) {
  return <div className={`lc-kpis ${cols ? `cols-${cols}` : ''}`}>{children}</div>;
}

export function KpiSkeleton({ count = 4 }) {
  const sk = (style) => <span className="boot-sk" style={style} />;
  return (
    <div className={`lc-kpis cols-${count}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ag-kpi sk">
          <div className="ag-kpi-top">
            {sk({ width: 30, height: 30, borderRadius: 9 })}
            {sk({ width: '46%', height: 11 })}
          </div>
          {sk({ width: 64, height: 26, marginTop: 14, borderRadius: 7 })}
          {sk({ width: '72%', height: 10, marginTop: 12 })}
        </div>
      ))}
    </div>
  );
}

/** Refined empty state: stacked-tile art, title, copy and an optional action. */
export function EmptyState({ icon = 'inbox', title, children, action, tone = 'brand', flat }) {
  return (
    <div className={`lc-empty ${flat ? 'flat' : ''} tone-${tone}`}>
      <div className="ag-empty-art" aria-hidden="true">
        <span className="ag-empty-tile back" />
        <span className="ag-empty-tile mid" />
        <span className="ag-empty-tile front">
          <Icon name={icon} size={22} />
        </span>
      </div>
      <h4>{title}</h4>
      {children && <p>{children}</p>}
      {action && <div className="lc-empty-action">{action}</div>}
    </div>
  );
}

/** Section card with an icon-chip header. */
export function SectionCard({ title, sub, icon, actions, children, flush, className = '', tone = 'brand' }) {
  return (
    <section className={`card lc-card ${flush ? 'flush' : ''} ${className}`}>
      {(title || actions) && (
        <header className="lc-card-head">
          {icon && (
            <span className={`lc-card-ic tone-${tone}`}>
              <Icon name={icon} size={15} />
            </span>
          )}
          <div className="lc-card-title">
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="lc-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Banner({ tone = 'info', icon = 'info', title, children, action }) {
  return (
    <div className={`banner ${tone}`}>
      <div className="ic">
        <Icon name={icon} size={17} />
      </div>
      <div className="grow">
        {title && <div className="t">{title}</div>}
        {children && <div className="d">{children}</div>}
      </div>
      {action}
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, subtitle, onClose, children, footer, wide }) {
  useEscape(onClose);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Drawer({ onClose, header, children }) {
  useEscape(onClose);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="grow">{header}</div>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

/** Inline confirm dialog (the CRM iframe can block window.confirm). */
export function Confirm({ title, children, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger-solid' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ color: 'var(--ink-2)' }}>{children}</div>
    </Modal>
  );
}

export function Menu({ items, trigger }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="rel" ref={ref}>
      {trigger ? (
        trigger(() => setOpen((o) => !o))
      ) : (
        <IconButton
          icon="dots"
          title="More"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        />
      )}
      {open && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          {items.filter(Boolean).map((it, i) =>
            it === '-' ? (
              <hr key={i} />
            ) : (
              <button
                key={it.label}
                className={it.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <Icon name={it.icon} size={15} />}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, message, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'err' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'err' ? 'alert' : 'check'} size={16} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run an async action with a toast on error; returns the result or undefined. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (fn, successMessage) => {
      try {
        const r = await fn();
        if (successMessage) toast(successMessage);
        return r;
      } catch (err) {
        toast(err.message || 'Something went wrong', 'err');
        return undefined;
      }
    },
    [toast],
  );
}
