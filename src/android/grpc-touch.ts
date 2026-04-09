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
