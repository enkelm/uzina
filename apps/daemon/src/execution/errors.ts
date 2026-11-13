export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
