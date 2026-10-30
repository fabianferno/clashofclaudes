import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));

const win = { setAlwaysOnTop: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

describe('__cocDriver', () => {
  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    await import('./driver');
  });

  const lastCall = () => invoke.mock.calls[invoke.mock.calls.length - 1];
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('run_reports_value_and_errors', async () => {
    const d = window.__cocDriver!;
    d.run(1, '1+1');
    await settled();
    expect(lastCall()).toEqual(['driver_result', { id: 1, ok: true, value: 2 }]);
    d.run(2, 'throw new Error("x")');
    await settled();
    expect(lastCall()).toEqual(['driver_result', { id: 2, ok: false, value: 'Error: x' }]);
    d.run(3, 'Promise.resolve(5)');
    await settled();
    expect(lastCall()).toEqual(['driver_result', { id: 3, ok: true, value: 5 }]);
  });

  it('front raises and focuses; unfront drops always-on-top', async () => {
    const d = window.__cocDriver!;
    await d.front();
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    expect(win.setFocus).toHaveBeenCalled();
    await d.unfront();
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it('snapshot and scene default to empty until registered', async () => {
    const m = await import('./driver');
    expect(await window.__cocDriver!.snapshot()).toBe('');
    expect(window.__cocDriver!.scene()).toBeNull();
    m.registerSnapshot(async () => 'png');
    m.registerScene(() => ({ a: 1 }));
    expect(await window.__cocDriver!.snapshot()).toBe('png');
    expect(window.__cocDriver!.scene()).toEqual({ a: 1 });
  });

  it('click and text use selectors', () => {
    document.body.innerHTML = '<button id="b">hi</button>';
    const d = window.__cocDriver!;
    const fn = vi.fn();
    document.getElementById('b')!.addEventListener('click', fn);
    expect(d.click('#b')).toBe(true);
    expect(fn).toHaveBeenCalled();
    expect(d.click('#none')).toBe(false);
    expect(d.text('#b')).toBe('hi');
    expect(d.text('#none')).toBeNull();
  });
});
