export const CODES = Object.freeze({
  unsupported: "unsupported",
  unavailable: "unavailable",
  timeout: "timeout",
  rateLimited: "rateLimited",
  signInRequired: "signInRequired",
  consentDeclined: "consentDeclined",
  invalidParams: "invalidParams",
  conflict: "conflict",
  previewRequired: "previewRequired",
  internal: "internal",
});

const PASS_THROUGH_CODES = new Set(Object.values(CODES));

export function ok(value) {
  return { ok: true, value, code: "", message: "" };
}

export function failure(code, message) {
  return { ok: false, value: null, code, message };
}

export function unsupported() {
  return failure(CODES.unsupported, "GameRush GameAPI is not available here.");
}

export function failureFromError(error) {
  const rawCode = error && typeof error.code === "string" ? error.code : "";
  const code =
    rawCode === "unsupportedMethod"
      ? CODES.unsupported
      : PASS_THROUGH_CODES.has(rawCode)
        ? rawCode
        : CODES.internal;
  const result = failure(code, messageOf(error, "GameRush API call failed."));
  if (error && typeof error.retryAfterMs === "number") result.retryAfterMs = error.retryAfterMs;
  return result;
}

const CLOUD_SAVE_STATUS_CODES = new Map([
  [0, CODES.unavailable],
  [400, CODES.invalidParams],
  [401, CODES.signInRequired],
  [409, CODES.conflict],
  [413, CODES.invalidParams],
  [429, CODES.rateLimited],
]);

export function failureFromCloudSaveError(error) {
  const status = error && typeof error.status === "number" ? error.status : null;
  const message = messageOf(error, "Cloud save failed.");
  if (status === null) {
    if (/timed out/i.test(message)) return failure(CODES.timeout, message);
    if (/only available inside GameRush|frame was destroyed/i.test(message)) {
      return failure(CODES.unavailable, message);
    }
    return failure(CODES.invalidParams, message);
  }
  if (status === 409 && /owner mismatch/i.test(message)) return failure(CODES.internal, message);
  return failure(CLOUD_SAVE_STATUS_CODES.get(status) ?? CODES.internal, message);
}

function messageOf(error, fallback) {
  return error && typeof error.message === "string" && error.message ? error.message : fallback;
}
