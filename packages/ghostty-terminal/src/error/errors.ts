export class BuildError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "BuildError"
    this.cause = cause
  }
}

export class FfiError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "FfiError"
    this.cause = cause
  }
}

export class PtyError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "PtyError"
    this.cause = cause
  }
}
