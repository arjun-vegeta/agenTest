export class LazyTestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'LazyTestError';
  }
}

export class AdbConnectionError extends LazyTestError {
  constructor(message: string) {
    super(message, 'ADB_CONNECTION_ERROR');
    this.name = 'AdbConnectionError';
  }
}

export class AdbCommandError extends LazyTestError {
  constructor(
    message: string,
    public readonly command: string,
  ) {
    super(message, 'ADB_COMMAND_ERROR');
    this.name = 'AdbCommandError';
  }
}

export class ElementNotFoundError extends LazyTestError {
  constructor(
    message: string,
    public readonly selector: Record<string, unknown>,
  ) {
    super(message, 'ELEMENT_NOT_FOUND');
    this.name = 'ElementNotFoundError';
  }
}

export class IdleTimeoutError extends LazyTestError {
  constructor(timeoutMs: number) {
    super(`UI did not stabilize within ${timeoutMs}ms`, 'IDLE_TIMEOUT');
    this.name = 'IdleTimeoutError';
  }
}

export class AssertionFailedError extends LazyTestError {
  constructor(
    message: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(message, 'ASSERTION_FAILED');
    this.name = 'AssertionFailedError';
  }
}

export class AppNotInstalledError extends LazyTestError {
  constructor(packageName: string) {
    super(`App "${packageName}" is not installed on the device`, 'APP_NOT_INSTALLED');
    this.name = 'AppNotInstalledError';
  }
}

export class TreeParseError extends LazyTestError {
  constructor(message: string) {
    super(message, 'TREE_PARSE_ERROR');
    this.name = 'TreeParseError';
  }
}
