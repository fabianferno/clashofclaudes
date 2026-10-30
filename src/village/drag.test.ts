import { describe, expect, it, vi } from 'vitest';
import { ease, type Cam } from './camera';
import { createDragController } from './drag';

function rig() {
  let cam: Cam = { x: 0, y: 0, zoom: 1 };
  let target: Cam | null = { x: -500, y: 300, zoom: 2 };
  const onAutoFitOff = vi.fn();
  const ctl = createDragController({
    getCam: () => cam,
    setCam: (c) => { cam = c; },
    setTarget: (t) => { target = t; },
    onAutoFitOff,
  });
  return {
    ctl, onAutoFitOff,
    get cam() { return cam; },
    get target() { return target; },
    easeSteps(n: number) { for (let i = 0; i < n; i++) if (target) cam = ease(cam, target, 1 / 60); },
  };
}

describe('drag controller', () => {
  it('drag_during_ease_continues_from_current_camera', () => {
    const r = rig();
    const preEase = { ...r.cam };
    r.easeSteps(10);
    const atPress = { ...r.cam };
    expect(atPress.x).not.toBe(preEase.x);
    r.ctl.down(100, 100);
    expect(r.target).toBeNull(); // ease cancelled
    r.ctl.move(130, 80);
    expect(r.cam.x).toBeCloseTo(atPress.x + 30, 9);
    expect(r.cam.y).toBeCloseTo(atPress.y - 20, 9);
    expect(r.cam.zoom).toBe(atPress.zoom);
    r.easeSteps(10); // nothing pulls the camera any more
    expect(r.cam.x).toBeCloseTo(atPress.x + 30, 9);
    expect(r.ctl.up()).toBe('drag');
  });

  it('click_without_crossing_threshold_keeps_autofit', () => {
    const r = rig();
    r.ctl.down(50, 50);
    r.ctl.move(52, 51);
    expect(r.ctl.up()).toBe('click');
    expect(r.onAutoFitOff).not.toHaveBeenCalled();
  });

  it('crossing_threshold_turns_autofit_off_once', () => {
    const r = rig();
    r.ctl.down(50, 50);
    r.ctl.move(60, 50);
    r.ctl.move(70, 50);
    expect(r.onAutoFitOff).toHaveBeenCalledTimes(1);
  });
});
