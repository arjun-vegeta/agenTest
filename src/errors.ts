export class AgenTestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AgenTestError';
  }
}

export class AdbConnectionError extends AgenTestError {
  constructor(message: string) {
    super(message, 'ADB_CONNECTION_ERROR');
    this.name = 'AdbConnectionError';
  }
}

export class AdbCommandError extends AgenTestError {
  constructor(
    message: string,
    public readonly command: string,
  ) {
    super(message, 'ADB_COMMAND_ERROR');
    this.name = 'AdbCommandError';
  }
}

export class ElementNotFoundError extends AgenTestError {
  constructor(
    message: string,
    public readonly selector: Record<string, unknown>,
  ) {
    super(message, 'ELEMENT_NOT_FOUND');
    this.name = 'ElementNotFoundError';
  }
}

export class IdleTimeoutError extends AgenTestError {
  constructor(timeoutMs: number) {
    super(`UI did not stabilize within ${timeoutMs}ms`, 'IDLE_TIMEOUT');
    this.name = 'IdleTimeoutError';
  }
}

export class AssertionFailedError extends AgenTestError {
  constructor(
    message: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(message, 'ASSERTION_FAILED');
    this.name = 'AssertionFailedError';
  }
}

export class AppNotInstalledError extends AgenTestError {
  constructor(packageName: string) {
    super(`App "${packageName}" is not installed on the device`, 'APP_NOT_INSTALLED');
    this.name = 'AppNotInstalledError';
  }
}

export class TreeParseError extends AgenTestError {
  constructor(message: string) {
    super(message, 'TREE_PARSE_ERROR');
    this.name = 'TreeParseError';
  }
}

export class GrpcConnectionError extends AgenTestError {
  constructor(message: string) {
    super(message, 'GRPC_CONNECTION_ERROR');
    this.name = 'GrpcConnectionError';
  }
}

export class GrpcRpcError extends AgenTestError {
  constructor(
    message: string,
    public readonly rpcMethod: string,
  ) {
    super(message, 'GRPC_RPC_ERROR');
    this.name = 'GrpcRpcError';
  }
}
