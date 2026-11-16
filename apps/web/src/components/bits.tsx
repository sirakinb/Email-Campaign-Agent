import { Mail, MessageCircle, MessageSquare, Clock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import type { Channel } from '../api';
import { CHANNEL_LABEL } from '../api';

/** The agent's face: an envelope with eyes. `asleep` closes them. */
export function Mascot({ size = 24, asleep = false, working = false }: { size?: number; asleep?: boolean; working?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ opacity: asleep ? 0.55 : 1, flex: 'none' }}>
      <rect x="2" y="6" width="28" height="21" rx="6" fill="var(--accent)" />
      <path d="M4.5 9.5L16 16.5L27.5 9.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {asleep ? (
        <>
          <path d="M9 21h4M19 21h4" stroke="#000" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx="11" cy="20.5" rx="1.8" ry="2.6" fill="#000">
            {working && <animate attributeName="ry" values="2.6;2.6;0.4;2.6;2.6" keyTimes="0;0.86;0.9;0.94;1" dur="3.2s" repeatCount="indefinite" />}
          </ellipse>
          <ellipse cx="21" cy="20.5" rx="1.8" ry="2.6" fill="#000">
            {working && <animate attributeName="ry" values="2.6;2.6;0.4;2.6;2.6" keyTimes="0;0.86;0.9;0.94;1" dur="3.2s" repeatCount="indefinite" />}
          </ellipse>
        </>
      )}
    </svg>
  );
}

export function ChannelIcon({ channel }: { channel: Channel }) {
  const Icon = channel === 'email' ? Mail : channel === 'text' ? MessageCircle : channel === 'automation' ? Clock : MessageSquare;
  return <Icon aria-hidden="true" />;
}

export function ChannelTag({ channel }: { channel: Channel }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <ChannelIcon channel={channel} />
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (next: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A single-hue bar list. The label and value are text; the bar carries proportion only. */
export function BarList({ rows, format = (v: number) => v.toLocaleString('en-US') }: { rows: { label: string; value: number; href?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((row, i) => (
        <div className="bar-row" key={`${row.label}-${i}`}>
          <span className="label" title={row.label}>
            {row.href ? (
              <a href={row.href} target="_blank" rel="noreferrer noopener">
                {row.label}
              </a>
            ) : (
              row.label
            )}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(row.value / max) * 100}%` }} />
          </div>
          <span className="value">{format(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

export type ColumnPoint = { key: string; label: string; value: number | null; second?: number | null; title: string };

/**
 * Column chart of one rate per send, oldest to newest, with an average line.
 * `second` draws a narrower inner column in the stronger tone (for example
 * reliable opens inside all opens).
 */
export function ColumnChart({ points, average, unit = '%', height = 200, onSelect }: { points: ColumnPoint[]; average: number | null; unit?: string; height?: number; onSelect?: (key: string) => void }) {
  const values = points.map((p) => p.value ?? 0);
  const top = niceMax(Math.max(...values, average ?? 0, 0.01));
  const W = 720;
  const padL = 40;
  const padB = 26;
  const padT = 12;
  const innerH = height - padB - padT;
  const slot = (W - padL) / Math.max(points.length, 1);
  const barW = Math.min(34, slot * 0.62);
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const ticks = [0, top / 2, top];
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Rate per send, oldest to newest" style={{ display: 'block' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--hairline)" />
          <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {trim(t)}
            {unit}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = padL + slot * i + (slot - barW) / 2;
        const h = Math.max(((p.value ?? 0) / top) * innerH, p.value ? 2 : 0);
        const h2 = p.second != null ? Math.max((p.second / top) * innerH, 2) : 0;
        return (
          <g key={p.key} onClick={() => onSelect?.(p.key)} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <title>{p.title}</title>
            <rect x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent" />
            <rect x={x} y={padT + innerH - h} width={barW} height={h} rx="4" fill="var(--accent)" opacity={p.second != null ? 0.38 : 1} />
            {p.second != null && <rect x={x} y={padT + innerH - h2} width={barW} height={h2} rx="4" fill="var(--accent)" />}
            {i % labelEvery === 0 && (
              <text x={padL + slot * i + slot / 2} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
                {p.label}
              </text>
            )}
          </g>
        );
      })}
      {average != null && (
        <g>
          <line x1={padL} x2={W} y1={y(average)} y2={y(average)} stroke="var(--ink)" strokeDasharray="3 4" opacity="0.55" />
          <text x={W - 4} y={y(average) - 6} textAnchor="end" fontSize="11" fill="var(--ink)">
            Average {trim(average)}
            {unit}
          </text>
        </g>
      )}
    </svg>
  );
}

function niceMax(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}
const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, ''));

export function Delta({ value, base, digits = 2 }: { value: number | null; base: number | null; digits?: number }) {
  if (value == null || base == null) return <span className="muted">No comparison yet</span>;
  const diff = value - base;
  if (Math.abs(diff) < 10 ** -digits / 2) return <span className="muted">Level with the six before</span>;
  return (
    <span className={diff > 0 ? 'delta-up' : 'delta-down'}>
      {diff > 0 ? 'Up' : 'Down'} {Math.abs(diff).toFixed(digits)} pts vs the six before
    </span>
  );
}
