import { Icon, WaGlyph } from './icons';

export const APP_NAME = 'WhatsApp Connector';

export default function Topbar({ crumb, tabs, tab, onTab, right }) {
  return (
    <header className="topbar">
      <div className="brandmark">
        <WaGlyph size={19} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="title">{APP_NAME}</span>
        {crumb && <span className="crumb">/ {crumb}</span>}
      </div>
      {tabs && (
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.value} className={`tab ${tab === t.value ? 'active' : ''}`} onClick={() => onTab(t.value)}>
              {t.icon && <Icon name={t.icon} size={15} />}
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </nav>
      )}
      <div className="spacer" />
      {right}
    </header>
  );
}
