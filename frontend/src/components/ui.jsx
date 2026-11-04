import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { initials } from '../lib/format';

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
