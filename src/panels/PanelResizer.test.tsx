import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PANEL_DEFAULT, PANEL_MIN, clampPanelWidth, usePanelWidth } from '../state/panelWidth';
import PanelResizer from './PanelResizer';

const KEY = 'coc.panelWidth';
beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1400;
  act(() => usePanelWidth.getState().reset());
  document.documentElement.className = '';
});

describe('clampPanelWidth', () => {
  it('keeps the panel between the minimum and 70% of the window', () => {
    expect(clampPanelWidth(100, 1400)).toBe(PANEL_MIN);
    expect(clampPanelWidth(2000, 1400)).toBe(980);
    expect(clampPanelWidth(500, 1400)).toBe(500);
    expect(clampPanelWidth(NaN, 1400)).toBe(PANEL_DEFAULT);
    expect(clampPanelWidth(600, 400)).toBe(PANEL_MIN); // never below the minimum
  });
});

describe('PanelResizer', () => {
  it('dragging the edge left widens the panel and keeps the width on release', () => {
    render(<PanelResizer />);
    const h = screen.getByTestId('panel-resizer');
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 1000, pointerType: 'mouse' });
    expect(document.documentElement.classList.contains('coc-panel-resizing')).toBe(true);
    expect(document.documentElement.classList.contains('gc-suspend')).toBe(true);
    act(() => { fireEvent.pointerUp(h, { pointerId: 1, clientX: 900, pointerType: 'mouse' }); });
    expect(usePanelWidth.getState().width).toBe(PANEL_DEFAULT + 100);
    expect(localStorage.getItem(KEY)).toBe(String(PANEL_DEFAULT + 100));
    expect(document.documentElement.classList.contains('coc-panel-resizing')).toBe(false);
  });
  it('clamps to the limits', () => {
    render(<PanelResizer />);
    const h = screen.getByTestId('panel-resizer');
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 1000, pointerType: 'mouse' });
    act(() => { fireEvent.pointerUp(h, { pointerId: 1, clientX: -500, pointerType: 'mouse' }); });
    expect(usePanelWidth.getState().width).toBe(980);
    fireEvent.pointerDown(h, { button: 0, pointerId: 1, clientX: 500, pointerType: 'mouse' });
    act(() => { fireEvent.pointerUp(h, { pointerId: 1, clientX: 1400, pointerType: 'mouse' }); });
    expect(usePanelWidth.getState().width).toBe(PANEL_MIN);
  });
  it('double-click puts the default back and forgets the kept width', () => {
    act(() => usePanelWidth.getState().setWidth(600, true));
    render(<PanelResizer />);
    act(() => { fireEvent.doubleClick(screen.getByTestId('panel-resizer')); });
    expect(usePanelWidth.getState().width).toBe(PANEL_DEFAULT);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
  it('ends the drag if the window loses focus mid-drag', () => {
    render(<PanelResizer />);
    fireEvent.pointerDown(screen.getByTestId('panel-resizer'), { button: 0, pointerId: 1, clientX: 1000, pointerType: 'mouse' });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(document.documentElement.classList.contains('coc-panel-resizing')).toBe(false);
  });
  it('arrow keys move the edge', () => {
    render(<PanelResizer />);
    act(() => { fireEvent.keyDown(screen.getByTestId('panel-resizer'), { key: 'ArrowLeft' }); });
    expect(usePanelWidth.getState().width).toBe(PANEL_DEFAULT + 16);
  });
  it('a narrower window squeezes the panel and a wider one gives the chosen width back', () => {
    act(() => usePanelWidth.getState().setWidth(900, true));
    act(() => { window.innerWidth = 1000; window.dispatchEvent(new Event('resize')); });
    expect(usePanelWidth.getState().width).toBe(700);
    act(() => { window.innerWidth = 1400; window.dispatchEvent(new Event('resize')); });
    expect(usePanelWidth.getState().width).toBe(900);
  });
});
