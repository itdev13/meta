import { Icon, WaGlyph } from './icons';

export const APP_NAME = 'Greenline';

export default function Topbar({ crumb, tabs, tab, onTab, right }) {
  return (
    <header className={`topbar ${tabs && tabs.length > 4 ? 'tb-many' : ''}`}>
      <div className="tb-brand">
        <div className="brandmark">
          <WaGlyph size={19} />
        </div>
        <div className="tb-word">
          <span className="title">{APP_NAME}</span>
          {crumb && <span className="crumb">{crumb}</span>}
        </div>
      </div>
      {tabs && (
        <div className="tb-tabs-wrap">
          <nav className="tabs" aria-label="Sections">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`tab ${tab === t.value ? 'active' : ''}`}
                aria-current={tab === t.value ? 'page' : undefined}
                onClick={() => onTab(t.value)}
              >
                {t.icon && <Icon name={t.icon} size={15} />}
                {t.label}
                {t.count ? <span className="count">{t.count}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      )}
      <div className="spacer" />
      {right && <div className="tb-right">{right}</div>}
    </header>
  );
}
