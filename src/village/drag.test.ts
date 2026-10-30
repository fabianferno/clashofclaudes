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
    setExternal(c: Cam) { cam = c; },
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
    r.ctl.move(110, 100); // crosses the threshold: rebases, no jump
    expect(r.cam).toEqual(atPress);
    r.ctl.move(130, 80);
    expect(r.cam.x).toBeCloseTo(atPress.x + 20, 9);
    expect(r.cam.y).toBeCloseTo(atPress.y - 20, 9);
    expect(r.cam.zoom).toBe(atPress.zoom);
    r.easeSteps(10); // nothing pulls the camera any more
    expect(r.cam.x).toBeCloseTo(atPress.x + 20, 9);
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

  it('rebases_at_threshold_so_external_camera_moves_do_not_snap_back', () => {
    const r = rig();
    r.ctl.down(0, 0);
    const moved: Cam = { x: 77, y: -9, zoom: 1.5 }; // e.g. auto-fit after a resize
    r.setExternal(moved);
    r.ctl.move(10, 0); // crosses the threshold
    expect(r.cam).toEqual(moved);
    r.ctl.move(20, 0);
    expect(r.cam.x).toBeCloseTo(moved.x + 10, 9);
    expect(r.cam.y).toBeCloseTo(moved.y, 9);
    expect(r.cam.zoom).toBe(1.5);
  });
});
