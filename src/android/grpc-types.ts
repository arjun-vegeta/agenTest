/**
 * Hand-written TypeScript interfaces for the subset of the
 * android.emulation.control proto we use. Avoids proto codegen
 * while maintaining type safety.
 */

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------

export interface GrpcTouchContact {
  x: number;
  y: number;
  identifier: number;
  /** >0 = finger down, 0 = finger up (release). */
  pressure: number;
  touch_major?: number;
  touch_minor?: number;
}

export interface GrpcTouchEvent {
  touches: GrpcTouchContact[];
  display?: number;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export enum GrpcKeyEventType {
  keydown = 0,
  keyup = 1,
  keypress = 2,
}

export interface GrpcKeyboardEvent {
  /** W3C key string (e.g. "Enter", "GoBack"). Mutually exclusive with text. */
  key?: string;
  /** UTF-8 text to type. Each char becomes a keypress. Mutually exclusive with key. */
  text?: string;
  eventType?: GrpcKeyEventType;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export enum GrpcImageFormatType {
  PNG = 0,
  RGBA8888 = 1,
  RGB888 = 2,
}

export interface GrpcImageFormat {
  format?: GrpcImageFormatType;
  width?: number;
  height?: number;
  display?: number;
}

export interface GrpcImage {
  format?: GrpcImageFormat;
  image: Buffer;
  seq?: number;
  timestampUs?: string;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export interface GrpcClipData {
  text: string;
}

// ---------------------------------------------------------------------------
// Emulator Status
// ---------------------------------------------------------------------------

export interface GrpcVmConfiguration {
  numberOfCpuCores?: number;
  ramSizeBytes?: string;
}

export interface GrpcEmulatorStatus {
  version?: string;
  uptime?: string;
  booted?: boolean;
  vmConfig?: GrpcVmConfiguration;
  guestConfig?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Swipe interpolation (internal, not proto)
// ---------------------------------------------------------------------------

export interface SwipeFrame {
  x: number;
  y: number;
  /** Milliseconds to wait after sending this frame. 0 for the last frame. */
  delayMs: number;
}
