import { describe, expect, it } from 'vitest';
import {
  interpolatePinchPath,
  interpolateRotatePath,
  interpolateSwipePath,
} from '../android/grpc-touch.js';
import { GRPC } from '../constants.js';

describe('interpolateSwipePath', () => {
  it('produces at least 2 frames for any duration', () => {
    const frames = interpolateSwipePath(0, 0, 100, 100, 1);
    expect(frames.length).toBeGreaterThanOrEqual(2);
  });

  it('starts at (x1, y1) and ends at (x2, y2)', () => {
    const frames = interpolateSwipePath(100, 200, 500, 800, 300);
    const first = frames[0];
    const last = frames[frames.length - 1];

    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first?.x).toBe(100);
    expect(first?.y).toBe(200);
    expect(last?.x).toBe(500);
    expect(last?.y).toBe(800);
  });

  it('last frame has delayMs of 0', () => {
    const frames = interpolateSwipePath(0, 0, 100, 100, 300);
    const last = frames[frames.length - 1];
    expect(last).toBeDefined();
    expect(last?.delayMs).toBe(0);
  });

  it('non-last frames have positive delayMs', () => {
    const frames = interpolateSwipePath(0, 0, 100, 100, 300);
    for (const [i, frame] of frames.entries()) {
      if (i < frames.length - 1) {
        expect(frame.delayMs).toBeGreaterThan(0);
      }
    }
  });

  it('produces ~18 frames for 300ms swipe at 60fps', () => {
    const frames = interpolateSwipePath(0, 0, 100, 100, 300);
    // 300ms * 60fps / 1000 = 18
    expect(frames.length).toBe(18);
  });

  it('produces ~60 frames for 1000ms swipe', () => {
    const frames = interpolateSwipePath(0, 0, 100, 100, 1000);
    expect(frames.length).toBe(GRPC.SWIPE_FPS);
  });

  it('intermediate frames are linearly interpolated', () => {
    const frames = interpolateSwipePath(0, 0, 100, 200, 300);
    // Check a middle frame is roughly at the midpoint
    const midIndex = Math.floor(frames.length / 2);
    const mid = frames[midIndex];
    expect(mid).toBeDefined();
    // Allow ±5 pixel tolerance due to rounding
    expect(mid?.x).toBeGreaterThanOrEqual(40);
    expect(mid?.x).toBeLessThanOrEqual(60);
    expect(mid?.y).toBeGreaterThanOrEqual(80);
    expect(mid?.y).toBeLessThanOrEqual(120);
  });

  it('handles zero-distance swipe (same start and end)', () => {
    const frames = interpolateSwipePath(100, 200, 100, 200, 300);
    for (const frame of frames) {
      expect(frame.x).toBe(100);
      expect(frame.y).toBe(200);
    }
  });

  it('coordinates are rounded to integers', () => {
    const frames = interpolateSwipePath(0, 0, 99, 99, 300);
    for (const frame of frames) {
      expect(Number.isInteger(frame.x)).toBe(true);
      expect(Number.isInteger(frame.y)).toBe(true);
    }
  });
});

describe('interpolatePinchPath', () => {
  it('starts at startRadius and ends at endRadius', () => {
    const frames = interpolatePinchPath(500, 500, 100, 300, 300);
    const first = frames[0];
    const last = frames[frames.length - 1];

    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // At startRadius=100, fingers at (400, 500) and (600, 500)
    expect(first?.finger0.x).toBe(400);
    expect(first?.finger1.x).toBe(600);
    // At endRadius=300, fingers at (200, 500) and (800, 500)
    expect(last?.finger0.x).toBe(200);
    expect(last?.finger1.x).toBe(800);
  });

  it('fingers are always symmetric around center', () => {
    const cx = 500;
    const frames = interpolatePinchPath(cx, 500, 50, 200, 300);
    for (const frame of frames) {
      // finger0 and finger1 should be equidistant from cx
      const dist0 = cx - frame.finger0.x;
      const dist1 = frame.finger1.x - cx;
      expect(dist0).toBe(dist1);
      // Y is unchanged
      expect(frame.finger0.y).toBe(500);
      expect(frame.finger1.y).toBe(500);
    }
  });

  it('produces frames at 60fps', () => {
    const frames = interpolatePinchPath(500, 500, 100, 200, 300);
    // 300ms * 60fps / 1000 = 18
    expect(frames.length).toBe(18);
  });

  it('pinch-in (shrinking radius) works', () => {
    const frames = interpolatePinchPath(500, 500, 300, 100, 300);
    // First frame: fingers far apart
    expect(frames[0]?.finger0.x).toBe(200);
    expect(frames[0]?.finger1.x).toBe(800);
    // Last frame: fingers close
    const last = frames[frames.length - 1];
    expect(last?.finger0.x).toBe(400);
    expect(last?.finger1.x).toBe(600);
  });
});

describe('interpolateRotatePath', () => {
  it('starts at startAngle and ends at endAngle', () => {
    // Rotate from 0 to 90 degrees (pi/2 rad), radius 100, center (500, 500)
    const frames = interpolateRotatePath(500, 500, 100, 0, Math.PI / 2, 400);
    const first = frames[0];
    const last = frames[frames.length - 1];

    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // At angle 0: finger0 = (600, 500), finger1 = (400, 500)
    expect(first?.finger0.x).toBe(600);
    expect(first?.finger0.y).toBe(500);
    expect(first?.finger1.x).toBe(400);
    expect(first?.finger1.y).toBe(500);
    // At angle pi/2: finger0 = (500, 600), finger1 = (500, 400)
    expect(last?.finger0.x).toBe(500);
    expect(last?.finger0.y).toBe(600);
    expect(last?.finger1.x).toBe(500);
    expect(last?.finger1.y).toBe(400);
  });

  it('fingers stay equidistant from center', () => {
    const cx = 500;
    const cy = 500;
    const radius = 150;
    const frames = interpolateRotatePath(cx, cy, radius, 0, Math.PI, 400);

    for (const frame of frames) {
      // Each finger distance from center should be ~radius
      const d0 = Math.sqrt((frame.finger0.x - cx) ** 2 + (frame.finger0.y - cy) ** 2);
      const d1 = Math.sqrt((frame.finger1.x - cx) ** 2 + (frame.finger1.y - cy) ** 2);
      // Allow ±2 px tolerance for rounding
      expect(Math.abs(d0 - radius)).toBeLessThanOrEqual(2);
      expect(Math.abs(d1 - radius)).toBeLessThanOrEqual(2);
    }
  });

  it('fingers are always on opposite sides of center', () => {
    const cx = 500;
    const cy = 500;
    const frames = interpolateRotatePath(cx, cy, 100, 0, Math.PI, 400);

    for (const frame of frames) {
      // midpoint of the two fingers should equal center
      const mx = (frame.finger0.x + frame.finger1.x) / 2;
      const my = (frame.finger0.y + frame.finger1.y) / 2;
      expect(mx).toBe(cx);
      expect(my).toBe(cy);
    }
  });
});
