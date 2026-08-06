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

const CAPABILITY_PATTERN = /ofx1\.(?:session|read|control|subscription|admin)\.[^.\s]+\.[A-Za-z0-9_-]+/gu;

function redact(value) {
  if (typeof value === "string") return value.replace(CAPABILITY_PATTERN, "[REDACTED_CAPABILITY]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

export function structuredError(error, fallback = {}) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: value.code || fallback.code || "ORACLE_FIREFOX_ERROR",
    message: redact(value.message),
    jobState: value.jobState ?? fallback.jobState ?? null,
    safeToRetry: value.safeToRetry ?? fallback.safeToRetry ?? false,
    submissionMayHaveOccurred:
      value.submissionMayHaveOccurred ?? fallback.submissionMayHaveOccurred ?? false,
    recoveryAction: redact(value.recoveryAction ?? fallback.recoveryAction ?? null),
    details: redact(value.details ?? fallback.details ?? null),
  };
}

export function codedError(code, message, options) {
  return new OracleFirefoxError(code, message, options);
}
