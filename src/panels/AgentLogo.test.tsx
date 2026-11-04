import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ANTIGRAVITY_COLOR, MARK_FILL_RULE, MARK_PATHS } from '../agentMarks';
import AgentLogo from './AgentLogo';

test("Antigravity wears its own arch in Google colours: blurred layers masked to the mark", () => {
  const { container } = render(<AgentLogo kind="antigravity" />);
  const mask = container.querySelector('mask path')!;
  expect(mask.getAttribute('d')).toBe(MARK_PATHS.antigravity);
  expect(MARK_PATHS.antigravity).toMatch(/^M21\.751 22\.607/); // Lobe Icons' antigravity mark, not a stand-in
  const layers = container.querySelectorAll('g[mask] > path');
  expect(layers).toHaveLength(ANTIGRAVITY_COLOR.length);
  expect(new Set(Array.from(layers, (p) => p.getAttribute('fill')))).toEqual(new Set(['#FFE432', '#FC413D', '#00B95C', '#3186FF', '#FBBC04', '#749BFF', '#FFEE48']));
  expect(container.querySelectorAll('filter feGaussianBlur')).toHaveLength(ANTIGRAVITY_COLOR.length);
});

test('two logos on one page keep their masks and filters apart', () => {
  const { container } = render(<><AgentLogo kind="antigravity" /><AgentLogo kind="antigravity" /></>);
  const ids = Array.from(container.querySelectorAll('mask, filter'), (e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('Codex and Antigravity marks are filled even-odd, as their sources are', () => {
  expect(MARK_FILL_RULE).toMatchObject({ codex: 'evenodd', antigravity: 'evenodd' });
  const { container } = render(<AgentLogo kind="codex" />);
  expect(container.querySelector('g > path')!.getAttribute('fill-rule')).toBe('evenodd');
});
