export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DecisionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
