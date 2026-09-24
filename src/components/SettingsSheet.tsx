import { useEffect, useRef, useState } from 'react';
import { contrastRatio, THEMES } from '../lib/contrast';
import { DEFAULT_SETTINGS, DYSLEXIA_PRESET, FONTS, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange: (p: Partial<Settings>) => void;
  onClose: () => void;
  isPdf?: boolean;
  hasPublisherCss?: boolean;
}

function Stepper({ label, value, display, onDec, onInc }: { label: string; value: number; display: string; onDec: () => void; onInc: () => void }) {
  const id = `lbl-${label.replace(/\W+/g, '-')}`;
  return (
    <div className="setting-row">
      <span className="setting-label" id={id}>{label}</span>
      <div className="stepper" role="group" aria-labelledby={id}>
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

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="setting-row toggle-row">
      <span>
        <span className="setting-label">{label}</span>
        {hint && <span className="hint small block">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <label className="setting-row col">
      <span className="setting-label slider-label">
        {label} <output>{display}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

type Tab = 'text' | 'spacing' | 'page' | 'theme' | 'marker' | 'extras';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'theme', label: 'Colours' },
  { id: 'page', label: 'Page' },
  { id: 'marker', label: 'Marker' },
  { id: 'extras', label: 'More' },
];

export default function SettingsSheet({ settings: s, onChange, onClose, isPdf = false, hasPublisherCss = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem('easyread:settingsTab') as Tab) || 'text';
    } catch {
      return 'text';
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem('easyread:settingsTab', tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, []);
  const ratio = contrastRatio(s.customFg, s.customBg);
  const font = FONTS.find((f) => f.id === s.font);

  return (
    <div className="overlay light-overlay" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label="Display settings" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Display</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="Setting groups">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="sheet-body" role="tabpanel">
          {tab === 'text' && (
            <>
              <div className="setting-row col">
                <span className="setting-label">Font</span>
                <div className="font-grid" role="radiogroup" aria-label="Font">
                  {FONTS.map((f) => (
                    <button key={f.id} role="radio" aria-checked={s.font === f.id} className={s.font === f.id ? 'on' : ''} style={{ fontFamily: f.stack }} onClick={() => onChange({ font: f.id })}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <Stepper label="Text size" value={s.fontSize} display={`${s.fontSize}px`} onDec={() => onChange({ fontSize: clamp(s.fontSize - 1, 12, 44) })} onInc={() => onChange({ fontSize: clamp(s.fontSize + 1, 12, 44) })} />
              <Slider
                label="Text thickness"
                value={s.fontWeight}
                min={300}
                max={700}
                step={font?.variable ? 10 : 100}
                display={s.fontWeight <= 350 ? 'Light' : s.fontWeight < 450 ? 'Regular' : s.fontWeight < 550 ? 'Medium' : s.fontWeight < 650 ? 'Semibold' : 'Bold'}
                onChange={(v) => onChange({ fontWeight: v })}
              />
              <Segmented label="Alignment" value={s.align} options={[{ id: 'left', label: 'Left' }, { id: 'justify', label: 'Justify' }]} onChange={(align) => onChange({ align })} />
              <Toggle label="Hyphenation" value={s.hyphens} onChange={(hyphens) => onChange({ hyphens })} />
              {hasPublisherCss && <Toggle label="Use publisher styles" hint="Keep the book's own formatting (your font, size and colours still apply)." value={s.publisherStyles} onChange={(publisherStyles) => onChange({ publisherStyles })} />}
              <button className="btn btn-small preset-btn" onClick={() => onChange(DYSLEXIA_PRESET)}>Dyslexia-friendly preset</button>
            </>
          )}

          {tab === 'spacing' && (
            <>
              <Stepper label="Line spacing" value={s.lineHeight} display={s.lineHeight.toFixed(1)} onDec={() => onChange({ lineHeight: round(clamp(s.lineHeight - 0.1, 1.1, 2.6), 1) })} onInc={() => onChange({ lineHeight: round(clamp(s.lineHeight + 0.1, 1.1, 2.6), 1) })} />
              <Slider label="Letter spacing" value={s.letterSpacing} min={-0.03} max={0.2} step={0.01} display={`${s.letterSpacing.toFixed(2)} em`} onChange={(v) => onChange({ letterSpacing: round(v) })} />
              <Slider label="Word spacing" value={s.wordSpacing} min={0} max={0.4} step={0.02} display={`${s.wordSpacing.toFixed(2)} em`} onChange={(v) => onChange({ wordSpacing: round(v) })} />
              <Slider label="Paragraph spacing" value={s.paragraphSpacing} min={0} max={2} step={0.1} display={`${s.paragraphSpacing.toFixed(1)} em`} onChange={(v) => onChange({ paragraphSpacing: round(v, 1) })} />
              <Slider label="First-line indent" value={s.indent} min={0} max={3} step={0.25} display={`${s.indent.toFixed(2)} em`} onChange={(v) => onChange({ indent: v })} />
              <Stepper label="Line width" value={s.maxWidth} display={`${s.maxWidth} chars`} onDec={() => onChange({ maxWidth: clamp(s.maxWidth - 5, 35, 100) })} onInc={() => onChange({ maxWidth: clamp(s.maxWidth + 5, 35, 100) })} />
              <div className="margins-grid">
                <Stepper label="Left margin" value={s.marginLeft} display={`${s.marginLeft}px`} onDec={() => onChange({ marginLeft: clamp(s.marginLeft - 4, 0, 96) })} onInc={() => onChange({ marginLeft: clamp(s.marginLeft + 4, 0, 96) })} />
                <Stepper label="Right margin" value={s.marginRight} display={`${s.marginRight}px`} onDec={() => onChange({ marginRight: clamp(s.marginRight - 4, 0, 96) })} onInc={() => onChange({ marginRight: clamp(s.marginRight + 4, 0, 96) })} />
                <Stepper label="Top margin" value={s.marginTop} display={`${s.marginTop}px`} onDec={() => onChange({ marginTop: clamp(s.marginTop - 4, 0, 120) })} onInc={() => onChange({ marginTop: clamp(s.marginTop + 4, 0, 120) })} />
                <Stepper label="Bottom margin" value={s.marginBottom} display={`${s.marginBottom}px`} onDec={() => onChange({ marginBottom: clamp(s.marginBottom - 4, 0, 120) })} onInc={() => onChange({ marginBottom: clamp(s.marginBottom + 4, 0, 120) })} />
              </div>
              <button
                className="btn btn-small preset-btn"
                onClick={() =>
                  onChange({
                    lineHeight: DEFAULT_SETTINGS.lineHeight,
                    letterSpacing: 0,
                    wordSpacing: 0,
                    paragraphSpacing: DEFAULT_SETTINGS.paragraphSpacing,
                    indent: DEFAULT_SETTINGS.indent,
                    maxWidth: DEFAULT_SETTINGS.maxWidth,
                    marginLeft: DEFAULT_SETTINGS.marginLeft,
                    marginRight: DEFAULT_SETTINGS.marginRight,
                    marginTop: DEFAULT_SETTINGS.marginTop,
                    marginBottom: DEFAULT_SETTINGS.marginBottom,
                  })
                }
              >
                Reset spacing
              </button>
            </>
          )}

          {tab === 'theme' && (
            <>
              <div className="setting-row col">
                <span className="setting-label">Theme</span>
                <div className="themes" role="radiogroup" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      role="radio"
                      aria-checked={s.theme === t.id}
                      className={`theme-swatch sw-${t.id}${s.theme === t.id ? ' on' : ''}`}
                      style={t.id === 'custom' ? { background: s.customBg, color: s.customFg } : undefined}
                      onClick={() => onChange({ theme: t.id })}
                    >
                      <span aria-hidden="true">Aa</span>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              {s.theme === 'custom' && (
                <div className="setting-row col">
                  <div className="color-row">
                    <label>
                      Text <input type="color" value={s.customFg} onChange={(e) => onChange({ customFg: e.target.value })} />
                    </label>
                    <label>
                      Background <input type="color" value={s.customBg} onChange={(e) => onChange({ customBg: e.target.value })} />
                    </label>
                  </div>
                  <p className={`hint small${ratio < 4.5 ? ' warn' : ''}`}>
                    Contrast {ratio.toFixed(1)}:1{ratio < 4.5 ? ' is too low for comfortable reading (aim for 7:1, at least 4.5:1).' : ratio >= 7 ? ', good.' : ', okay.'}
                  </p>
                </div>
              )}
              <Slider label="Dim the screen" value={s.dim} min={0} max={0.7} step={0.05} display={s.dim ? `${Math.round(s.dim * 100)}%` : 'Off'} onChange={(dim) => onChange({ dim })} />
              <p className="hint small">Dims below your device's lowest brightness, for reading in the dark.</p>
            </>
          )}

          {tab === 'page' && (
            <>
              <Segmented
                label="Reading mode"
                value={s.mode}
                options={[{ id: 'paged', label: 'Pages' }, { id: 'scroll', label: 'Scroll' }, ...(isPdf ? [{ id: 'original' as const, label: 'Original PDF' }] : [])]}
                onChange={(mode) => onChange({ mode })}
              />
              {isPdf && s.mode === 'original' && (
                <>
                  <Toggle label="Crop white margins" value={s.pdfCrop} onChange={(pdfCrop) => onChange({ pdfCrop })} />
                  <Stepper label="Zoom" value={s.pdfZoom} display={`${Math.round(s.pdfZoom * 100)}%`} onDec={() => onChange({ pdfZoom: round(clamp(s.pdfZoom - 0.25, 0.5, 4)) })} onInc={() => onChange({ pdfZoom: round(clamp(s.pdfZoom + 0.25, 0.5, 4)) })} />
                </>
              )}
              <Segmented
                label="Tap zones"
                value={s.tapLayout}
                options={[
                  { id: 'left-right', label: 'Left / right' },
                  { id: 'top-bottom', label: 'Top / bottom' },
                  { id: 'mostly-forward', label: 'Mostly forward' },
                ]}
                onChange={(tapLayout) => onChange({ tapLayout })}
              />
              <Toggle label="Page-turn animation" value={s.pageAnimation} onChange={(pageAnimation) => onChange({ pageAnimation })} />
              <Toggle label="Two pages on wide screens" value={s.spread} onChange={(spread) => onChange({ spread })} />
              <div className="setting-row col">
                <span className="setting-label">Status bar</span>
                <div className="check-grid">
                  {(
                    [
                      ['statusProgress', 'Percent read'],
                      ['statusChapterTime', 'Time left in chapter'],
                      ['statusPagesLeft', 'Pages left in chapter'],
                      ['statusClock', 'Clock'],
                      ['statusBattery', 'Battery'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k}>
                      <input type="checkbox" checked={s[k]} onChange={(e) => onChange({ [k]: e.target.checked } as Partial<Settings>)} /> {label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'marker' && (
            <>
              <Toggle label="Marking mode" hint="Tap a word to mark where you stopped. Swipe or tap the margins to turn pages. Shortcut: the Mark button at the bottom, or M." value={s.markMode} onChange={(markMode) => onChange({ markMode })} />
              <Segmented label="Marker style" value={s.markerStyle} options={[{ id: 'bar', label: 'Margin bar' }, { id: 'underline', label: 'Underline' }, { id: 'none', label: 'Hidden' }]} onChange={(markerStyle) => onChange({ markerStyle })} />
              <Toggle label="Dim text before the marker" value={s.markerDim} onChange={(markerDim) => onChange({ markerDim })} />
              <Toggle label="Auto-mark when turning the page" hint="Marks the last word of the page you leave." value={s.autoMark} onChange={(autoMark) => onChange({ autoMark })} />
            </>
          )}

          {tab === 'extras' && (
            <>
              <Toggle label="Reading ruler" hint="A band that helps you keep your place. Drag its handle to move it." value={s.ruler} onChange={(ruler) => onChange({ ruler })} />
              <Toggle label="Keep screen on" value={s.keepAwake} onChange={(keepAwake) => onChange({ keepAwake })} />
              <Toggle label="Bold word starts" hint="Also called bionic reading. Studies found no speed or comprehension benefit, but some people like it." value={s.boldStarts} onChange={(boldStarts) => onChange({ boldStarts })} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
