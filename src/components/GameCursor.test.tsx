import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import GameCursor, { cursorModeOf } from './GameCursor';

const el = (html: string, pick: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector(pick)!;
};
afterEach(() => { document.body.innerHTML = ''; document.documentElement.className = ''; });

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
    expect(cursorModeOf(el('<button><span>Go</span></button>', 'span'))).toBe('hover');
    expect(cursorModeOf(el('<a href="#">x</a>', 'a'))).toBe('hover');
    expect(cursorModeOf(el('<article role="button"><div>card</div></article>', 'div'))).toBe('hover');
    expect(cursorModeOf(el('<input type="range">', 'input'))).toBe('hover');
    expect(cursorModeOf(el('<input type="checkbox">', 'input'))).toBe('hover');
  });
  it('is the plain pointer elsewhere, and over disabled buttons', () => {
    expect(cursorModeOf(el('<p>text</p>', 'p'))).toBe('normal');
    expect(cursorModeOf(el('<button disabled>x</button>', 'button'))).toBe('normal');
    expect(cursorModeOf(null)).toBe('normal');
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
    expect(cur.classList.contains('gc-hover')).toBe(true);

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
  it('steps aside while something asks for the OS cursor everywhere (gc-suspend)', () => {
    render(<GameCursor />);
    const cur = screen.getByTestId('game-cursor');
    document.documentElement.classList.add('gc-suspend');
    act(() => { fireEvent.pointerMove(document.body, { clientX: 5, clientY: 5, pointerType: 'mouse' }); });
    expect(cur.classList.contains('gc-visible')).toBe(false);
  });
});
