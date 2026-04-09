import { describe, expect, it } from 'vitest';
import { interpolateSwipePath } from '../android/grpc-touch.js';
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
