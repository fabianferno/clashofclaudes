import type { CSSProperties } from 'react';

/** The list plus `value` when it is not in it (a saved choice the agent no longer lists). */
const withCurrent = (options: string[], value: string) => (value && !options.includes(value) ? [...options, value] : options);

const effortName = (e: string) => (e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

/** Above this many steps the tick labels would crowd: only the chosen value is named. */
const MAX_TICKS = 6;

/**
 * A choice as a stepped slider: Default first, then `options` in order. '' is the default.
 * `name` turns a value into its label.
 */
function StepSlider({ label, options, value, onChange, disabled, name }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void; disabled: boolean; name: (v: string) => string;
}) {
  const steps = ['', ...withCurrent(options, value)];
  const at = Math.max(0, steps.indexOf(value));
  const show = (s: string) => (s ? name(s) : 'Default');
  return (
    <label className="sp-field">
      <span>{label}: <b className="slider-value">{show(steps[at])}</b></span>
      <input className="step-slider" type="range" aria-label={label} aria-valuetext={show(steps[at])}
        min={0} max={steps.length - 1} step={1} value={at} disabled={disabled}
        style={{ '--fill': `${(at / Math.max(1, steps.length - 1)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(steps[Number(e.target.value)] ?? '')} />
      {steps.length <= MAX_TICKS && (
        <span className="slider-ticks" aria-hidden="true">
          {steps.map((s) => <span key={s || 'default'}>{show(s)}</span>)}
        </span>
      )}
    </label>
  );
}

/** The model as a slider: Default, then the agent's models from fastest to most capable. */
export function ModelSlider(p: { label: string; options: string[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <StepSlider {...p} disabled={p.disabled ?? false} name={(m) => m} />;
}

/** Effort as a slider: Default, then each of the agent's efforts from lowest to highest. */
export function EffortSlider(p: { label: string; options: string[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <StepSlider {...p} disabled={p.disabled ?? false} name={effortName} />;
}
