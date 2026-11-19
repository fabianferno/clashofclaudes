import { beforeEach, expect, test } from 'vitest';
import { MAX_PANEL_ZOOM, MIN_PANEL_ZOOM, usePanelZoom } from './panelZoom';

beforeEach(() => { localStorage.clear(); usePanelZoom.setState({ zoom: 1 }); });

test('steps in tenths, stays within bounds, and 0 puts it back', () => {
  const { step } = usePanelZoom.getState();
  step('in'); step('in');
  expect(usePanelZoom.getState().zoom).toBe(1.2);
  expect(localStorage.getItem('coc.panelZoom')).toBe('1.2');
  for (let i = 0; i < 30; i++) step('in');
  expect(usePanelZoom.getState().zoom).toBe(MAX_PANEL_ZOOM);
  for (let i = 0; i < 30; i++) step('out');
  expect(usePanelZoom.getState().zoom).toBe(MIN_PANEL_ZOOM);
  step('fit');
  expect(usePanelZoom.getState().zoom).toBe(1);
  expect(localStorage.getItem('coc.panelZoom')).toBeNull();
});
