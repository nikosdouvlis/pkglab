export class PkglError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PkglError";
  }
}

export class DaemonNotRunningError extends PkglError {
  constructor(msg = "Verdaccio is not running. Run: pkgl start") {
    super(msg);
    this.name = "DaemonNotRunningError";
  }
}

export class DaemonAlreadyRunningError extends PkglError {
  constructor(msg: string) {
    super(msg);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class PortInUseError extends PkglError {
  constructor(port: number) {
    super(`Port ${port} is already in use`);
    this.name = "PortInUseError";
  }
}

export class LockAcquisitionError extends PkglError {
  constructor(msg: string) {
    super(msg);
    this.name = "LockAcquisitionError";
  }
}

export class CycleDetectedError extends PkglError {
  constructor(msg: string) {
    super(msg);
    this.name = "CycleDetectedError";
  }
}

export class NpmrcConflictError extends PkglError {
  constructor(msg: string) {
    super(msg);
    this.name = "NpmrcConflictError";
  }
}

export class PackageManagerAmbiguousError extends PkglError {
  constructor(msg: string) {
    super(msg);
    this.name = "PackageManagerAmbiguousError";
  }
}
