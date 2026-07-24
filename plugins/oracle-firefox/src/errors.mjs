export class OracleFirefoxError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "OracleFirefoxError";
    this.code = code;
    this.jobState = options.jobState ?? null;
    this.safeToRetry = options.safeToRetry ?? false;
    this.submissionMayHaveOccurred = options.submissionMayHaveOccurred ?? false;
    this.recoveryAction = options.recoveryAction ?? null;
    this.details = options.details ?? null;
  }
}

export function structuredError(error, fallback = {}) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: value.code || fallback.code || "ORACLE_FIREFOX_ERROR",
    message: value.message,
    jobState: value.jobState ?? fallback.jobState ?? null,
    safeToRetry: value.safeToRetry ?? fallback.safeToRetry ?? false,
    submissionMayHaveOccurred:
      value.submissionMayHaveOccurred ?? fallback.submissionMayHaveOccurred ?? false,
    recoveryAction: value.recoveryAction ?? fallback.recoveryAction ?? null,
    details: value.details ?? fallback.details ?? null,
  };
}

export function codedError(code, message, options) {
  return new OracleFirefoxError(code, message, options);
}
