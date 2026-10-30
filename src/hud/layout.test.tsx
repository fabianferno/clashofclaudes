import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PANEL_W } from '../village/camera';
import { useApp } from '../state/store';
import BuildButtons from './BuildButtons';
import BuildersBar from './BuildersBar';
import TopBar from './TopBar';
import { BUILD_MARGIN, BUILD_W } from './layout';

const setPanel = (open: boolean) => act(() => useApp.setState({ panelOpen: open }));

test('resources right offset follows panelOpen', () => {
  render(<TopBar />);
  const el = document.getElementById('resources')!;
  setPanel(false);
  const closed = parseFloat(el.style.right);
  setPanel(true);
  expect(parseFloat(el.style.right)).toBe(closed + PANEL_W);
  setPanel(false);
});

test('roster reservation covers the build buttons footprint in both panel states', () => {
  render(<><BuildersBar /><BuildButtons /></>);
  const zone = document.querySelector('.hud-roster-zone') as HTMLElement;
  const btns = screen.getByTestId('build-buttons');
  for (const open of [false, true]) {
    setPanel(open);
    const inset = open ? PANEL_W : 0;
    // distance of the zone's content edge from the viewport's right edge vs the buttons' left edge from it
    const barClearance = parseFloat(zone.style.right) + parseFloat(zone.style.paddingRight);
    const btnFootprint = parseFloat(btns.style.right) + parseFloat(btns.style.width);
    expect(parseFloat(zone.style.right)).toBe(inset);
    expect(barClearance).toBeGreaterThanOrEqual(btnFootprint);
    expect(btnFootprint).toBe(inset + BUILD_MARGIN + BUILD_W);
  }
  setPanel(false);
});
