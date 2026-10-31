import { useId, type CSSProperties } from 'react';

/** The list plus `value` when it is not in it (a saved choice the agent no longer lists). */
const withCurrent = (options: string[], value: string) => (value && !options.includes(value) ? [...options, value] : options);

const effortName = (e: string) => (e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

/**
 * One model out of `options`, as a row of buttons (a radio group). '' is the agent's default.
 * A disabled group (a fieldset) disables every button.
 */
export function ModelButtons({ label, options, value, onChange, disabled = false }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="sp-field">
      <span id={id}>{label}</span>
      <fieldset className="seg" role="radiogroup" aria-labelledby={id} aria-label={label} disabled={disabled}>
        {['', ...withCurrent(options, value)].map((o) => (
          <button key={o || 'default'} type="button" role="radio" aria-checked={o === value}
            className={`seg-btn${o === value ? ' on' : ''}`} onClick={() => onChange(o)}>
            {o || 'Default'}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** Effort as a slider: Default, then each of `options` from lowest to highest. '' is the default. */
export function EffortSlider({ label, options, value, onChange, disabled = false }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  const steps = ['', ...withCurrent(options, value)];
  const at = Math.max(0, steps.indexOf(value));
  const name = (s: string) => (s ? effortName(s) : 'Default');
  return (
    <label className="sp-field">
      <span>{label}: <b className="slider-value">{name(steps[at])}</b></span>
      <input className="effort-slider" type="range" aria-label={label} aria-valuetext={name(steps[at])}
        min={0} max={steps.length - 1} step={1} value={at} disabled={disabled}
        style={{ '--fill': `${(at / Math.max(1, steps.length - 1)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(steps[Number(e.target.value)] ?? '')} />
      <span className="slider-ticks" aria-hidden="true">
        {steps.map((s) => <span key={s || 'default'}>{name(s)}</span>)}
      </span>
    </label>
  );
}
