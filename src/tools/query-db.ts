import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { ShellExecutor } from '../types.js';

export interface QueryDbResult {
  packageName: string;
  database: string;
  query: string;
  rows: string;
}

export async function handleQueryDb(
  shell: ShellExecutor,
  packageName: string,
  database: string,
  query: string,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
): Promise<QueryDbResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const rows = await device.queryDatabase(packageName, database, query);

  return {
    packageName,
    database,
    query,
    rows,
  };
}
