/**
 * gRPC client for the Android Emulator's EmulatorController service.
 * Connects to localhost:{consolePort + 3000} (e.g., port 8554 for emulator-5554).
 *
 * Handles: input injection (touch, key), screenshots, clipboard.
 * Does NOT handle: accessibility tree, app lifecycle, device properties — those stay on ADB.
 *
 * Auth: Newer emulators require a bearer token discovered from pid_*.ini files.
 * The token is sent as `authorization: Bearer <token>` metadata on every RPC.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GRPC } from '../constants.js';
import { GrpcConnectionError, GrpcRpcError } from '../errors.js';
import type {
  GrpcClipData,
  GrpcEmulatorStatus,
  GrpcImage,
  GrpcImageFormat,
  GrpcKeyboardEvent,
  GrpcTouchEvent,
} from './grpc-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the proto file relative to this module */
const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'emulator_controller.proto');

/** Proto-loader options for dynamic loading */
const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
  includeDirs: [join(__dirname, '..', '..', 'proto')],
};

export class GrpcEmulatorClient {
  private client: grpc.Client | null = null;
  private connected = false;
  private readonly address: string;
  private authMetadata: grpc.Metadata | null = null;

  /**
   * @param port   gRPC port (typically consolePort + 3000)
   * @param token  Bearer token from emulator discovery file (pid_*.ini)
   */
  constructor(port: number, token?: string) {
    this.address = `localhost:${port}`;
    if (token) {
      this.authMetadata = new grpc.Metadata();
      this.authMetadata.add('authorization', `Bearer ${token}`);
    }
  }

  /**
   * Load the proto, create the gRPC stub, and verify the connection
   * by calling getStatus().
   */
  async connect(): Promise<void> {
    const packageDefinition = await protoLoader.load(PROTO_PATH, PROTO_LOADER_OPTIONS);
    const proto = grpc.loadPackageDefinition(packageDefinition);

    // Navigate to the service constructor: android.emulation.control.EmulatorController
    const androidNs = proto['android'] as Record<string, unknown> | undefined;
    const emulationNs = androidNs?.['emulation'] as Record<string, unknown> | undefined;
    const controlNs = emulationNs?.['control'] as Record<string, unknown> | undefined;
    const ServiceConstructor = controlNs?.['EmulatorController'] as
      | (new (address: string, credentials: grpc.ChannelCredentials) => grpc.Client)
      | undefined;

    if (!ServiceConstructor) {
      throw new GrpcConnectionError(
        'Failed to load EmulatorController service from proto definition',
      );
    }

    this.client = new ServiceConstructor(this.address, grpc.credentials.createInsecure());

    // Health check: call getStatus with a short deadline
    try {
      await this.rpc<Record<string, never>, GrpcEmulatorStatus>(
        'getStatus',
        {},
        GRPC.CONNECT_TIMEOUT_MS,
      );
      this.connected = true;
    } catch (err) {
      this.close();
      const msg = err instanceof Error ? err.message : String(err);
      throw new GrpcConnectionError(
        `Failed to connect to emulator gRPC at ${this.address}: ${msg}`,
      );
    }
  }

  /** Close the gRPC channel. */
  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Public RPC methods
  // -------------------------------------------------------------------------

  async sendTouch(event: GrpcTouchEvent): Promise<void> {
    await this.rpc<GrpcTouchEvent, Record<string, never>>('sendTouch', event);
  }

  async sendKey(event: GrpcKeyboardEvent): Promise<void> {
    await this.rpc<GrpcKeyboardEvent, Record<string, never>>('sendKey', event);
  }

  async getScreenshot(format?: GrpcImageFormat): Promise<GrpcImage> {
    return this.rpc<GrpcImageFormat | Record<string, never>, GrpcImage>(
      'getScreenshot',
      format ?? {},
    );
  }

  async setClipboard(text: string): Promise<void> {
    await this.rpc<GrpcClipData, Record<string, never>>('setClipboard', { text });
  }

  async getClipboard(): Promise<string> {
    const result = await this.rpc<Record<string, never>, GrpcClipData>('getClipboard', {});
    return result.text;
  }

  async getStatus(): Promise<GrpcEmulatorStatus> {
    return this.rpc<Record<string, never>, GrpcEmulatorStatus>('getStatus', {});
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private rpc<TReq, TRes>(
    method: string,
    request: TReq,
    deadlineMs: number = GRPC.RPC_DEADLINE_MS,
  ): Promise<TRes> {
    if (!this.client) {
      return Promise.reject(new GrpcRpcError('gRPC client is not connected', method));
    }

    // Dynamic method lookup on the generated client stub
    const fn = (this.client as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new GrpcRpcError(`Unknown gRPC method: ${method}`, method));
    }

    const bound = fn.bind(this.client) as (
      request: TReq,
      metadata: grpc.Metadata,
      options: { deadline: Date },
      callback: (error: grpc.ServiceError | null, response: TRes) => void,
    ) => void;

    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + deadlineMs);
      const metadata = this.authMetadata ?? new grpc.Metadata();
      bound(request, metadata, { deadline }, (error, response) => {
        if (error) {
          reject(new GrpcRpcError(`${method} failed: ${error.message}`, method));
        } else {
          resolve(response);
        }
      });
    });
  }
}
