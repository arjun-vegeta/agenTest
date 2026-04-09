/**
 * Pure functions for converting high-level gestures (tap, swipe, long press)
 * into sequences of gRPC sendTouch RPC calls.
 */

import { GRPC } from '../constants.js';
import type { GrpcEmulatorClient } from './grpc-client.js';
import type { SwipeFrame } from './grpc-types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tap at (x, y) — finger down then finger up.
 */
export async function performTap(grpc: GrpcEmulatorClient, x: number, y: number): Promise<void> {
  await grpc.sendTouch({
    touches: [{ x, y, identifier: GRPC.DEFAULT_FINGER_ID, pressure: GRPC.DEFAULT_PRESSURE }],
  });
  await grpc.sendTouch({
    touches: [{ x, y, identifier: GRPC.DEFAULT_FINGER_ID, pressure: GRPC.RELEASE_PRESSURE }],
  });
}

/**
 * Compute interpolated swipe path frames at ~60fps.
 * Pure function — easy to unit test.
 */
export function interpolateSwipePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): SwipeFrame[] {
  const frameCount = Math.max(Math.ceil((durationMs / 1000) * GRPC.SWIPE_FPS), 2);
  const frameInterval = durationMs / (frameCount - 1);
  const frames: SwipeFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = i / (frameCount - 1);
    frames.push({
      x: Math.round(x1 + (x2 - x1) * t),
      y: Math.round(y1 + (y2 - y1) * t),
      delayMs: i < frameCount - 1 ? frameInterval : 0,
    });
  }

  return frames;
}

/**
 * Swipe from (x1,y1) to (x2,y2) over durationMs using interpolated touch events.
 */
export async function performSwipe(
  grpc: GrpcEmulatorClient,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  const frames = interpolateSwipePath(x1, y1, x2, y2, durationMs);

  for (const [i, frame] of frames.entries()) {
    const isLast = i === frames.length - 1;
    await grpc.sendTouch({
      touches: [
        {
          x: frame.x,
          y: frame.y,
          identifier: GRPC.DEFAULT_FINGER_ID,
          pressure: isLast ? GRPC.RELEASE_PRESSURE : GRPC.DEFAULT_PRESSURE,
        },
      ],
    });
    if (frame.delayMs > 0) {
      await sleep(frame.delayMs);
    }
  }
}

/**
 * Long press at (x, y) — finger down, hold for durationMs, finger up.
 */
export async function performLongPress(
  grpc: GrpcEmulatorClient,
  x: number,
  y: number,
  durationMs: number,
): Promise<void> {
  await grpc.sendTouch({
    touches: [{ x, y, identifier: GRPC.DEFAULT_FINGER_ID, pressure: GRPC.DEFAULT_PRESSURE }],
  });
  await sleep(durationMs);
  await grpc.sendTouch({
    touches: [{ x, y, identifier: GRPC.DEFAULT_FINGER_ID, pressure: GRPC.RELEASE_PRESSURE }],
  });
}

/**
 * Compute two-finger pinch frames. Both fingers move symmetrically
 * on a horizontal line through (cx, cy), with radius changing over time.
 * Pure function — easy to unit test.
 */
export interface PinchFrame {
  finger0: { x: number; y: number };
  finger1: { x: number; y: number };
  delayMs: number;
}

export function interpolatePinchPath(
  cx: number,
  cy: number,
  startRadius: number,
  endRadius: number,
  durationMs: number,
): PinchFrame[] {
  const frameCount = Math.max(Math.ceil((durationMs / 1000) * GRPC.SWIPE_FPS), 2);
  const frameInterval = durationMs / (frameCount - 1);
  const frames: PinchFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = i / (frameCount - 1);
    const r = startRadius + (endRadius - startRadius) * t;
    frames.push({
      finger0: { x: Math.round(cx - r), y: cy },
      finger1: { x: Math.round(cx + r), y: cy },
      delayMs: i < frameCount - 1 ? frameInterval : 0,
    });
  }

  return frames;
}

/**
 * Pinch gesture: two fingers move between startRadius and endRadius
 * around (cx, cy). pinch-in (startRadius > endRadius) = zoom out.
 * pinch-out (startRadius < endRadius) = zoom in.
 */
export async function performPinch(
  grpc: GrpcEmulatorClient,
  cx: number,
  cy: number,
  startRadius: number,
  endRadius: number,
  durationMs: number,
): Promise<void> {
  const frames = interpolatePinchPath(cx, cy, startRadius, endRadius, durationMs);

  for (const [i, frame] of frames.entries()) {
    const isLast = i === frames.length - 1;
    const pressure = isLast ? GRPC.RELEASE_PRESSURE : GRPC.DEFAULT_PRESSURE;
    await grpc.sendTouch({
      touches: [
        { x: frame.finger0.x, y: frame.finger0.y, identifier: 0, pressure },
        { x: frame.finger1.x, y: frame.finger1.y, identifier: 1, pressure },
      ],
    });
    if (frame.delayMs > 0) {
      await sleep(frame.delayMs);
    }
  }
}

/**
 * Compute two-finger rotate frames. Fingers are on opposite sides of (cx, cy)
 * at the given radius, rotating from startAngle to endAngle (in radians).
 * Pure function — easy to unit test.
 */
export function interpolateRotatePath(
  cx: number,
  cy: number,
  radius: number,
  startAngleRad: number,
  endAngleRad: number,
  durationMs: number,
): PinchFrame[] {
  const frameCount = Math.max(Math.ceil((durationMs / 1000) * GRPC.SWIPE_FPS), 2);
  const frameInterval = durationMs / (frameCount - 1);
  const frames: PinchFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = i / (frameCount - 1);
    const angle = startAngleRad + (endAngleRad - startAngleRad) * t;
    const dx = Math.round(radius * Math.cos(angle));
    const dy = Math.round(radius * Math.sin(angle));
    frames.push({
      finger0: { x: cx + dx, y: cy + dy },
      finger1: { x: cx - dx, y: cy - dy },
      delayMs: i < frameCount - 1 ? frameInterval : 0,
    });
  }

  return frames;
}

/**
 * Rotate gesture: two fingers rotate around (cx, cy) at fixed radius.
 * Angles are in radians. Positive = counter-clockwise in screen coordinates.
 */
export async function performRotate(
  grpc: GrpcEmulatorClient,
  cx: number,
  cy: number,
  radius: number,
  startAngleRad: number,
  endAngleRad: number,
  durationMs: number,
): Promise<void> {
  const frames = interpolateRotatePath(cx, cy, radius, startAngleRad, endAngleRad, durationMs);

  for (const [i, frame] of frames.entries()) {
    const isLast = i === frames.length - 1;
    const pressure = isLast ? GRPC.RELEASE_PRESSURE : GRPC.DEFAULT_PRESSURE;
    await grpc.sendTouch({
      touches: [
        { x: frame.finger0.x, y: frame.finger0.y, identifier: 0, pressure },
        { x: frame.finger1.x, y: frame.finger1.y, identifier: 1, pressure },
      ],
    });
    if (frame.delayMs > 0) {
      await sleep(frame.delayMs);
    }
  }
}
