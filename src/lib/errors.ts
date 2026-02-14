export class pkglabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "pkglabError";
  }
}

export class DaemonNotRunningError extends pkglabError {
  constructor(msg = "Verdaccio is not running. Run: pkglab up") {
    super(msg);
    this.name = "DaemonNotRunningError";
  }
}

export class DaemonAlreadyRunningError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class LockAcquisitionError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "LockAcquisitionError";
  }
}

export class CycleDetectedError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "CycleDetectedError";
  }
}

export class NpmrcConflictError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = "NpmrcConflictError";
  }
}

