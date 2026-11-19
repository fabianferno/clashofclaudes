import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import GameCursor, { cursorModeOf, setCursorHint } from './GameCursor';

const el = (html: string, pick: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector(pick)!;
};
afterEach(() => { document.body.innerHTML = ''; document.documentElement.className = ''; document.documentElement.removeAttribute('data-gc'); });

describe('cursorModeOf', () => {
  it('keeps the OS cursor for text entry, the terminal, resize handles and embedded pages', () => {
    expect(cursorModeOf(el('<input type="text">', 'input'))).toBe('native');
    expect(cursorModeOf(el('<input>', 'input'))).toBe('native');
    expect(cursorModeOf(el('<textarea></textarea>', 'textarea'))).toBe('native');
    expect(cursorModeOf(el('<div class="xterm"><div><canvas></canvas></div></div>', 'canvas'))).toBe('native');
    expect(cursorModeOf(el('<div class="gc-native"><span></span></div>', 'span'))).toBe('native');
    expect(cursorModeOf(el('<iframe></iframe>', 'iframe'))).toBe('native');
    expect(cursorModeOf(el('<div contenteditable="true"><b>x</b></div>', 'b'))).toBe('native');
  });
  it('lights up over clickable things', () => {
    expect(cursorModeOf(el('<button><span>Go</span></button>', 'span'))).toBe('pointer');
    expect(cursorModeOf(el('<a href="#">x</a>', 'a'))).toBe('pointer');
    expect(cursorModeOf(el('<article role="button"><div>card</div></article>', 'div'))).toBe('pointer');
    expect(cursorModeOf(el('<input type="range">', 'input'))).toBe('pointer');
    expect(cursorModeOf(el('<input type="checkbox">', 'input'))).toBe('pointer');
  });
  it('is the plain pointer elsewhere, and the no-entry one over disabled buttons', () => {
    expect(cursorModeOf(el('<p>text</p>', 'p'))).toBe('normal');
    expect(cursorModeOf(el('<button disabled>x</button>', 'button'))).toBe('blocked');
    expect(cursorModeOf(null)).toBe('normal');
  });
  it('takes a hint from the element or the page, and closes the hand while pressed', () => {
    const canvas = el('<div class="hud-card"><canvas></canvas></div>', 'canvas');
    setCursorHint(canvas, 'grab');
    expect(cursorModeOf(canvas)).toBe('grab');
    expect(cursorModeOf(canvas, true)).toBe('grabbing');
    setCursorHint(canvas, null);
    expect(cursorModeOf(canvas)).toBe('pointer');
    setCursorHint(document.documentElement, 'busy');
    expect(cursorModeOf(canvas)).toBe('busy');
    expect(cursorModeOf(el('<input>', 'input'))).toBe('busy');
  });
});

describe('GameCursor', () => {
  it('appears on the first move, hides over a text field, and hides when the mouse leaves the window', () => {
    render(<><GameCursor /><button>Go</button><input aria-label="name" /></>);
    const cur = screen.getByTestId('game-cursor');
    expect(cur.classList.contains('gc-visible')).toBe(false);
    expect(document.documentElement.classList.contains('gc-on')).toBe(false);

    act(() => { fireEvent.pointerMove(screen.getByText('Go'), { clientX: 10, clientY: 20, pointerType: 'mouse' }); });
    expect(document.documentElement.classList.contains('gc-on')).toBe(true);
    expect(cur.classList.contains('gc-visible')).toBe(true);
    expect(cur.classList.contains('gc-m-pointer')).toBe(true);

    act(() => { fireEvent.pointerDown(screen.getByText('Go'), { pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-down')).toBe(true);
    act(() => { fireEvent.pointerUp(screen.getByText('Go'), { pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-down')).toBe(false);

    act(() => { fireEvent.pointerMove(screen.getByLabelText('name'), { clientX: 30, clientY: 20, pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-visible')).toBe(false);

    act(() => { fireEvent.pointerMove(document.body, { clientX: 40, clientY: 20, pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-visible')).toBe(true);
    act(() => { fireEvent.mouseLeave(document.documentElement); });
    expect(cur.classList.contains('gc-visible')).toBe(false);
  });
  it('changes shape when a hint changes under a still pointer', async () => {
    render(<><GameCursor /><canvas data-testid="cv" /></>);
    const cur = screen.getByTestId('game-cursor');
    const cv = screen.getByTestId('cv');
    act(() => { fireEvent.pointerMove(cv, { clientX: 5, clientY: 5, pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-m-normal')).toBe(true);
    await act(async () => { setCursorHint(cv, 'grabbing'); await Promise.resolve(); });
    expect(cur.classList.contains('gc-m-grabbing')).toBe(true);
  });
  it('steps aside while something asks for the OS cursor everywhere (gc-suspend)', () => {
    render(<GameCursor />);
    const cur = screen.getByTestId('game-cursor');
    document.documentElement.classList.add('gc-suspend');
    act(() => { fireEvent.pointerMove(document.body, { clientX: 5, clientY: 5, pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-visible')).toBe(false);
  });
});
