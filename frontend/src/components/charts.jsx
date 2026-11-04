import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';

/**
 * Hand-built SVG charts (no chart library). Colors come from CSS custom properties defined in the
 * "Analytics" block at the end of styles.css (`--viz-*`), so a theme change is one place.
 *
 * Rules followed (dataviz method): one y-axis; thin marks (2px lines, ≤24px bars with a 4px
 * rounded data end and square baseline); 2px surface gap between touching marks; recessive
 * hairline grid; legend for ≥2 series; text never wears the series color; every chart has a
 * hover/focus tooltip and an accessible name; the values are also reachable as a table.
 */

// ── Shared helpers ────────────────────────────────────────────────────

export function useMeasure() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/** Clean ticks from 0 to ≥max: 0 / 50 / 100 … */
export function niceTicks(max, count = 4) {
  if (!max || max <= 0) return [0, 1];
  const step = Math.max(1, niceStep(max / count));
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function compact(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** Column with a 4px rounded data end and a square baseline. */
function colPath(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Floating tooltip positioned inside a `position:relative` chart frame; flips near the right edge. */
function Tooltip({ x, y, frameWidth, children }) {
  const ref = useRef(null);
  const [w, setW] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  });
  const left = x + 14 + w > frameWidth ? Math.max(0, x - 14 - w) : x + 14;
  return (
    <div ref={ref} className="viz-tip" style={{ left, top: Math.max(0, y) }} role="status" aria-live="polite">
      {children}
    </div>
  );
}

function TipRow({ color, value, label, kind = 'line' }) {
  return (
    <div className="viz-tip-row">
      <span className={`viz-key ${kind}`} style={{ '--c': color }} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Legend({ items, kind = 'rect' }) {
  return (
    <ul className="viz-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.key || it.label}>
          <span className={`viz-key ${it.kind || kind}`} style={{ '--c': it.color }} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ caption, columns, rows }) {
  return (
    <details className="viz-table">
      <summary>View as table</summary>
      <div className="table-wrap">
        <table>
          <caption className="viz-sr">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.num ? 'num' : ''}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.format ? c.format(r[c.key], r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Time series: lines+area wash (long ranges) or grouped columns (≤14 points) ─────

/**
 * props
 *   data      [{ date: 'YYYY-MM-DD', [series.key]: number, … }]
 *   series    [{ key, label, color }]          — 1–4 series on one y-axis
 *   strip     { key, label, color, icon }      — optional small-multiple strip under the plot
 *                                                (own scale; used for failures so the status red
 *                                                never sits next to the brand green)
 *   formatX   (key, long) => string
 *   type      'auto' | 'line' | 'bar'
 */
export function TimeSeriesChart({ data, series, strip, formatX = (k) => k, formatValue = compact, height = 240, type = 'auto', title, description }) {
  const [frameRef, width] = useMeasure();
  const [idx, setIdx] = useState(null);
  const uid = useId();
  const n = data.length;
  const mode = type === 'auto' ? (n <= 14 ? 'bar' : 'line') : type;

  const pad = { l: 44, r: mode === 'line' ? 44 : 12, t: 10, b: 26 };
  const stripH = strip ? 44 : 0;
  const plotH = height - pad.t - pad.b;
  const plotW = Math.max(10, width - pad.l - pad.r);
  const band = n ? plotW / n : plotW;
  const cx = (i) => pad.l + band * i + band / 2;

  const max = useMemo(() => Math.max(0, ...data.flatMap((d) => series.map((s) => d[s.key] || 0))), [data, series]);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v) => pad.t + plotH - (v / top) * plotH;

  const stripMax = strip ? Math.max(0, ...data.map((d) => d[strip.key] || 0)) : 0;

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.l;
    setIdx(Math.min(n - 1, Math.max(0, Math.floor(px / band))));
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight') setIdx((i) => Math.min(n - 1, (i ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, (i ?? n) - 1));
    else if (e.key === 'Home') setIdx(0);
    else if (e.key === 'End') setIdx(n - 1);
    else if (e.key === 'Escape') setIdx(null);
    else return;
    e.preventDefault();
  };

  // Grouped columns geometry
  const k = series.length;
  const barW = Math.max(2, Math.min(24, (band * 0.72 - 2 * (k - 1)) / k));
  const groupW = barW * k + 2 * (k - 1);

  // End labels for lines — only if they don't collide (else legend + tooltip carry identity).
  const endLabels = useMemo(() => {
    if (mode !== 'line' || !n || k > 4) return [];
    const last = data[n - 1];
    const ys = series.map((s) => ({ s, y: y(last[s.key] || 0), v: last[s.key] || 0 })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ys.length; i += 1) if (ys[i].y - ys[i - 1].y < 14) return [];
    return ys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, data, series, top, plotH]);

  const totalH = height + stripH;
  const hovered = idx != null ? data[idx] : null;

  return (
    <div className="viz-ts">
      <Legend items={series} kind={mode === 'line' ? 'line' : 'rect'} />
      <div className="viz-frame" ref={frameRef} style={{ height: totalH }}>
        {width > 0 && (
          <svg
            width={width}
            height={totalH}
            viewBox={`0 0 ${width} ${totalH}`}
            role="img"
            aria-labelledby={`${uid}-t ${uid}-d`}
            tabIndex={0}
            onPointerMove={onMove}
            onPointerLeave={() => setIdx(null)}
            onKeyDown={onKey}
            onBlur={() => setIdx(null)}
            className="viz-svg"
          >
            <title id={`${uid}-t`}>{title || 'Time series'}</title>
            <desc id={`${uid}-d`}>{description || `${series.map((s) => s.label).join(', ')} per day. Use the arrow keys to step through days.`}</desc>

            {/* grid + y-axis */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={pad.l + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
                <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                  {compact(t)}
                </text>
              </g>
            ))}

            {/* x labels */}
            {data.map((d, i) =>
              i % labelEvery === 0 ? (
                <text key={d.date} x={cx(i)} y={height - 8} textAnchor="middle" className="viz-tick">
                  {formatX(d.date)}
                </text>
              ) : null,
            )}

            {mode === 'bar'
              ? data.map((d, i) => (
                  <g key={d.date} className={idx != null && idx !== i ? 'viz-dim' : ''}>
                    {series.map((s, j) => {
                      const v = d[s.key] || 0;
                      const x0 = cx(i) - groupW / 2 + j * (barW + 2);
                      return <path key={s.key} d={colPath(x0, y(v), barW, y(0) - y(v))} fill={s.color} />;
                    })}
                  </g>
                ))
              : series.map((s) => {
                  const pts = data.map((d, i) => [cx(i), y(d[s.key] || 0)]);
                  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
                  const area = `${line}L${pts[pts.length - 1][0]},${y(0)}L${pts[0][0]},${y(0)}Z`;
                  return (
                    <g key={s.key}>
                      <path d={area} fill={s.color} opacity={0.1} />
                      <path d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  );
                })}

            {endLabels.map(({ s, y: ly, v }) => (
              <g key={s.key}>
                <circle cx={cx(n - 1)} cy={ly} r={4} fill={s.color} className="viz-ring" />
                <text x={cx(n - 1) + 9} y={ly} dy="0.32em" className="viz-endlabel">
                  {formatValue(v)}
                </text>
              </g>
            ))}

            {/* crosshair */}
            {hovered && (
              <g pointerEvents="none">
                <line x1={cx(idx)} x2={cx(idx)} y1={pad.t} y2={y(0) + (strip ? stripH : 0)} className="viz-cross" />
                {mode === 'line' &&
                  series.map((s) => <circle key={s.key} cx={cx(idx)} cy={y(hovered[s.key] || 0)} r={4} fill={s.color} className="viz-ring" />)}
              </g>
            )}

            {/* strip small-multiple */}
            {strip && (
              <g transform={`translate(0, ${height})`}>
                <text x={pad.l - 8} y={stripH / 2 - 4} dy="0.32em" textAnchor="end" className="viz-tick">
                  {strip.label}
                </text>
                <line x1={pad.l} x2={pad.l + plotW} y1={stripH - 10} y2={stripH - 10} className="viz-base" />
                {data.map((d, i) => {
                  const v = d[strip.key] || 0;
                  const h = stripMax ? Math.max(v ? 2 : 0, (v / stripMax) * (stripH - 18)) : 0;
                  const w = Math.max(2, Math.min(14, band * 0.6));
                  return <path key={d.date} d={colPath(cx(i) - w / 2, stripH - 10 - h, w, h, 3)} fill={strip.color} opacity={idx != null && idx !== i ? 0.45 : 1} />;
                })}
                {!stripMax && (
                  <text x={pad.l + 6} y={stripH - 18} className="viz-tick">
                    None in this period
                  </text>
                )}
              </g>
            )}

            <rect x={pad.l} y={0} width={plotW} height={totalH} fill="transparent" />
          </svg>
        )}
        {hovered && width > 0 && (
          <Tooltip x={cx(idx)} y={pad.t} frameWidth={width}>
            <div className="viz-tip-h">{formatX(hovered.date, true)}</div>
            {series.map((s) => (
              <TipRow key={s.key} color={s.color} value={formatValue(hovered[s.key] || 0)} label={s.label} kind={mode === 'line' ? 'line' : 'rect'} />
            ))}
            {strip && <TipRow color={strip.color} value={formatValue(hovered[strip.key] || 0)} label={strip.label} kind="rect" />}
          </Tooltip>
        )}
      </div>
      <DataTable
        caption={title || 'Daily values'}
        columns={[
          { key: 'date', label: 'Day', format: (v) => formatX(v, true) },
          ...series.map((s) => ({ key: s.key, label: s.label, num: true, format: (v) => (v || 0).toLocaleString() })),
          ...(strip ? [{ key: strip.key, label: strip.label, num: true, format: (v) => (v || 0).toLocaleString() }] : []),
        ]}
        rows={data}
      />
    </div>
  );
}

// ── Sparkline + KPI stat ──────────────────────────────────────────────

export function Sparkline({ values = [], width = 96, height = 28, label }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = (width - 6) / (values.length - 1);
  const pts = values.map((v, i) => [3 + i * step, height - 3 - (v / max) * (height - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="viz-spark" role="img" aria-label={label || 'Trend'}>
      <path d={`${d}L${last[0]},${height}L3,${height}Z`} className="viz-spark-area" />
      <path d={d} className="viz-spark-line" />
      <circle cx={last[0]} cy={last[1]} r={3} className="viz-spark-dot" />
    </svg>
  );
}

/** Stat tile: label · value · sub · optional sparkline (de-emphasis line, accent end). */
export function KpiStat({ label, value, unit, sub, icon, spark, tone, loading }) {
  return (
    <div className={`card kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-k">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      {loading ? (
        <div className="skeleton" style={{ height: 30, width: '60%', marginTop: 8 }} />
      ) : (
        <div className="kpi-row">
          <div className="kpi-v">
            {value}
            {unit && <small>{unit}</small>}
          </div>
          {spark && <Sparkline values={spark} label={`${label} trend`} />}
        </div>
      )}
      {sub && !loading && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Horizontal bar list ───────────────────────────────────────────────

/** items: [{ key, label, sub?, value, color? }] — one hue (magnitude), value at the bar's tip. */
export function BarList({ items, format = compact, color = 'var(--viz-seq)', emptyText = 'Nothing yet', onSelect, label }) {
  const [hover, setHover] = useState(null);
  if (!items.length) return <div className="viz-empty">{emptyText}</div>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="viz-barlist" aria-label={label}>
      {items.map((it) => {
        const Tag = onSelect ? 'button' : 'div';
        return (
          <li key={it.key || it.label} className={hover && hover !== (it.key || it.label) ? 'dim' : ''}>
            <Tag
              className="viz-bl-row"
              type={onSelect ? 'button' : undefined}
              onClick={onSelect ? () => onSelect(it) : undefined}
              onPointerEnter={() => setHover(it.key || it.label)}
              onPointerLeave={() => setHover(null)}
              title={`${it.label}: ${format(it.value)}`}
            >
              <div className="viz-bl-top">
                <span className="viz-bl-label">{it.label}</span>
                {it.sub && <span className="viz-bl-sub">{it.sub}</span>}
                <span className="viz-bl-val tnum">{format(it.value)}</span>
              </div>
              <div className="viz-bl-track">
                <div className="viz-bl-fill" style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%`, background: it.color || color }} />
              </div>
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}

// ── 7×24 heatmap ──────────────────────────────────────────────────────

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HEAT_STEPS = 6;
const hourLabel = (h) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

/** cells: 7 rows (Mon→Sun) × 24 hours. Sequential single-hue ramp, zero = sunken surface. */
export function Heatmap({ cells, max, unit = 'messages', title = 'Busiest hours' }) {
  const [frameRef, width] = useMeasure();
  const [cur, setCur] = useState(null); // [row, col]
  const uid = useId();
  const padL = 36;
  const padT = 4;
  const gap = 2;
  const cw = Math.max(6, (width - padL) / 24);
  const ch = Math.min(26, Math.max(14, cw * 0.82));
  const h = padT + ch * 7 + 22;
  const step = (v) => (v <= 0 || !max ? 0 : Math.min(HEAT_STEPS, Math.max(1, Math.ceil((v / max) * HEAT_STEPS))));

  const onKey = (e) => {
    const [r, c] = cur || [0, 0];
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (!moves[e.key]) return;
    e.preventDefault();
    if (!cur) return setCur([0, 0]);
    setCur([Math.min(6, Math.max(0, r + moves[e.key][0])), Math.min(23, Math.max(0, c + moves[e.key][1]))]);
  };

  // Peak cell for the description.
  let peak = null;
  cells.forEach((row, r) => row.forEach((v, c) => { if (!peak || v > peak.v) peak = { r, c, v }; }));

  return (
    <div className="viz-heat">
      <div className="viz-frame" ref={frameRef} style={{ height: h }}>
        {width > 0 && (
          <svg
            width={width}
            height={h}
            viewBox={`0 0 ${width} ${h}`}
            role="img"
            aria-labelledby={`${uid}-t ${uid}-d`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setCur(null)}
            onPointerLeave={() => setCur(null)}
            className="viz-svg"
          >
            <title id={`${uid}-t`}>{title}</title>
            <desc id={`${uid}-d`}>
              {peak && peak.v ? `Busiest: ${DOW[peak.r]} ${hourLabel(peak.c)} with ${peak.v} ${unit}.` : 'No activity.'} Arrow keys move between hours.
            </desc>
            {DOW.map((d, r) => (
              <text key={d} x={padL - 8} y={padT + r * ch + ch / 2} dy="0.32em" textAnchor="end" className="viz-tick">
                {d}
              </text>
            ))}
            {cells.map((row, r) =>
              row.map((v, c) => {
                const active = cur && cur[0] === r && cur[1] === c;
                return (
                  <rect
                    key={`${r}-${c}`}
                    x={padL + c * cw + gap / 2}
                    y={padT + r * ch + gap / 2}
                    width={cw - gap}
                    height={ch - gap}
                    rx={3}
                    className={`viz-hc s${step(v)} ${active ? 'on' : ''}`}
                    onPointerEnter={() => setCur([r, c])}
                  />
                );
              }),
            )}
            {Array.from({ length: 8 }, (_, i) => i * 3).map((hr) => (
              <text key={hr} x={padL + hr * cw + cw / 2} y={padT + ch * 7 + 14} textAnchor="middle" className="viz-tick">
                {hourLabel(hr)}
              </text>
            ))}
          </svg>
        )}
        {cur && width > 0 && (
          <Tooltip x={padL + cur[1] * cw + cw} y={padT + cur[0] * ch - 8} frameWidth={width}>
            <div className="viz-tip-h">
              {DOW[cur[0]]} · {hourLabel(cur[1])}–{hourLabel((cur[1] + 1) % 24)}
            </div>
            <TipRow color="var(--viz-seq)" value={cells[cur[0]][cur[1]].toLocaleString()} label={unit} kind="rect" />
          </Tooltip>
        )}
      </div>
      <div className="viz-heat-legend" aria-hidden="true">
        <span>Less</span>
        {Array.from({ length: HEAT_STEPS + 1 }, (_, i) => (
          <i key={i} className={`viz-hc-swatch s${i}`} />
        ))}
        <span>More</span>
      </div>
      <DataTable
        caption={title}
        columns={[{ key: 'day', label: 'Day' }, ...Array.from({ length: 24 }, (_, hr) => ({ key: `h${hr}`, label: hourLabel(hr), num: true }))]}
        rows={cells.map((row, r) => ({ day: DOW[r], ...Object.fromEntries(row.map((v, hr) => [`h${hr}`, v])) }))}
      />
    </div>
  );
}

// ── Segmented bar (one whole, split into parts) ───────────────────────

/** parts: [{ key, label, value, color, ink? }] in a FIXED order (identity, never rank). */
export function SegmentedBar({ parts, format = compact, label = 'Split' }) {
  const [hover, setHover] = useState(null);
  const total = parts.reduce((n, p) => n + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  const share = (v) => (total ? v / total : 0);
  const pct = (v) => `${Math.round(share(v) * 100)}%`;
  const name = `${label}: ${parts.map((p) => `${p.label} ${format(p.value)} (${pct(p.value)})`).join(', ')}`;
  const [frameRef, width] = useMeasure();

  return (
    <div className="viz-seg">
      <div className="viz-seg-bar" ref={frameRef} role="img" aria-label={name}>
        {total === 0 ? (
          <div className="viz-seg-empty" />
        ) : (
          visible.map((p) => {
            const w = share(p.value) * width;
            return (
              <div
                key={p.key}
                className={`viz-seg-part ${hover && hover !== p.key ? 'dim' : ''}`}
                style={{ flexGrow: p.value, background: p.color, color: p.ink || '#fff' }}
                tabIndex={0}
                aria-label={`${p.label}: ${format(p.value)}, ${pct(p.value)}`}
                onPointerEnter={() => setHover(p.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.key)}
                onBlur={() => setHover(null)}
              >
                {w > 46 && <span>{pct(p.value)}</span>}
              </div>
            );
          })
        )}
      </div>
      <ul className="viz-seg-legend">
        {parts.map((p) => (
          <li key={p.key} className={hover && hover !== p.key ? 'dim' : ''} onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)}>
            <span className="viz-key rect" style={{ '--c': p.color }} />
            <span className="grow">{p.label}</span>
            <strong className="tnum">{format(p.value)}</strong>
            <span className="muted tnum">{total ? pct(p.value) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ratio meter (thin track, fill carries the value). tone: 'ok' | 'warn' | 'err'. */
export function Meter({ value, tone = 'ok', label }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className={`viz-meter ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <div style={{ width: `${v * 100}%` }} />
    </div>
  );
}
