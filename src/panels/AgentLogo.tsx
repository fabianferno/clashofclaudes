import { useId } from 'react';
import type { AgentKind } from '../api/types';
import { MARK_FILL_RULE, MARK_GRADIENT, MARK_PATHS, PROMPT_GLYPH, TILES } from '../agentMarks';

/**
 * The agent as an app icon: its mark on a rounded, shaded tile, `size` px square. Decorative (the
 * label beside it names the agent). `framed`: a thick dark outline, like the HUD's buttons.
 */
export default function AgentLogo({ kind, size = 56, framed = false }: { kind: AgentKind; size?: number; framed?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const t = TILES[kind];
  const fg = t.fg === 'gradient' ? `url(#${uid}-mark)` : t.fg;
  const path = MARK_PATHS[kind] ?? null;
  return (
    <svg className="agent-logo" data-testid={`agent-logo-${kind}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={t.top} />
          <stop offset="1" stopColor={t.bottom} />
        </linearGradient>
        <linearGradient id={`${uid}-mark`} x1="0" y1="0" x2="1" y2="1">
          {MARK_GRADIENT.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
        </linearGradient>
        <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${uid}-bg)`} />
      <g transform="translate(16 16) scale(1.333)">
        {path
          ? <path d={path} fill={fg} fillRule={MARK_FILL_RULE[kind]} />
          : (
            <>
              <path d={PROMPT_GLYPH[0]} fill="none" stroke={fg} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d={PROMPT_GLYPH[1]} stroke={fg} strokeWidth="2.6" strokeLinecap="round" />
            </>
          )}
      </g>
      <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#${uid}-gloss)`} />
      {framed
        ? <rect x="3.5" y="3.5" width="57" height="57" rx="12.5" fill="none" stroke="#1d130b" strokeWidth="4" />
        : <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="#000" strokeOpacity="0.18" />}
    </svg>
  );
}
