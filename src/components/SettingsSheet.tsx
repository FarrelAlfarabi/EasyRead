import { useEffect, useRef } from 'react';
import type { FontFamily, Settings } from '../lib/settings';
import { FONT_STACKS } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (p: Partial<Settings>) => void;
  onClose: () => void;
}

const THEMES: Array<{ id: Settings['theme']; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'Black' },
  { id: 'night', label: 'Night' },
];

const FONTS: Array<{ id: FontFamily; label: string }> = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans' },
  { id: 'hyperlegible', label: 'Hyperlegible' },
];

function Stepper({ label, value, display, onDec, onInc }: { label: string; value: number; display: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="setting-row">
      <span className="setting-label" id={`lbl-${label}`}>{label}</span>
      <div className="stepper" role="group" aria-labelledby={`lbl-${label}`}>
        <button className="step-btn" onClick={onDec} aria-label={`Decrease ${label.toLowerCase()}`}>−</button>
        <output className="step-val" aria-live="polite" data-value={value}>{display}</output>
        <button className="step-btn" onClick={onInc} aria-label={`Increase ${label.toLowerCase()}`}>+</button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string; style?: React.CSSProperties }>; onChange: (v: T) => void }) {
  return (
    <div className="setting-row col">
      <span className="setting-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} style={o.style} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number) => Math.round(v * 100) / 100;

export default function SettingsSheet({ settings: s, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  return (
    <div className="overlay light-overlay" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label="Display settings" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Display</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-body">
          <div className="setting-row col">
            <span className="setting-label">Theme</span>
            <div className="themes" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button key={t.id} role="radio" aria-checked={s.theme === t.id} className={`theme-swatch sw-${t.id}${s.theme === t.id ? ' on' : ''}`} onClick={() => onChange({ theme: t.id })}>
                  <span aria-hidden="true">Aa</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <Segmented label="Font" value={s.font} options={FONTS.map((f) => ({ ...f, style: { fontFamily: FONT_STACKS[f.id] } }))} onChange={(font) => onChange({ font })} />

          <Stepper label="Text size" value={s.fontSize} display={`${s.fontSize}px`} onDec={() => onChange({ fontSize: clamp(s.fontSize - 1, 12, 40) })} onInc={() => onChange({ fontSize: clamp(s.fontSize + 1, 12, 40) })} />
          <Stepper label="Line spacing" value={s.lineHeight} display={s.lineHeight.toFixed(1)} onDec={() => onChange({ lineHeight: round(clamp(s.lineHeight - 0.1, 1.2, 2.4)) })} onInc={() => onChange({ lineHeight: round(clamp(s.lineHeight + 0.1, 1.2, 2.4)) })} />
          <Stepper label="Margins" value={s.margin} display={`${s.margin}px`} onDec={() => onChange({ margin: clamp(s.margin - 4, 4, 64) })} onInc={() => onChange({ margin: clamp(s.margin + 4, 4, 64) })} />
          <Stepper label="Line width" value={s.maxWidth} display={`${s.maxWidth} chars`} onDec={() => onChange({ maxWidth: clamp(s.maxWidth - 5, 40, 90) })} onInc={() => onChange({ maxWidth: clamp(s.maxWidth + 5, 40, 90) })} />

          <Segmented label="Alignment" value={s.align} options={[{ id: 'left', label: 'Left' }, { id: 'justify', label: 'Justify' }]} onChange={(align) => onChange({ align })} />
          <Segmented label="Hyphenation" value={s.hyphens ? 'on' : 'off'} options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} onChange={(v) => onChange({ hyphens: v === 'on' })} />
          <Segmented label="Reading mode" value={s.mode} options={[{ id: 'paged', label: 'Pages' }, { id: 'scroll', label: 'Scroll' }]} onChange={(mode) => onChange({ mode })} />
          <Segmented label="Two pages on wide screens" value={s.spread ? 'on' : 'off'} options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} onChange={(v) => onChange({ spread: v === 'on' })} />
        </div>
      </div>
    </div>
  );
}
