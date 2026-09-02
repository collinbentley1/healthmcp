// Structured decoding of Google's canonical API error envelope.
//
// Every Firestore REST failure carries the same shape, verified against both
// the live API and the emulator:
//
//   {"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}
//
// The reason this needs a real parser rather than a substring test is that
// ABORTED and ALREADY_EXISTS are BOTH HTTP 409 and are distinguished only by
// `status`. Observed verbatim from the emulator:
//
//   409 {"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}
//   409 {"error":{"code":409,"message":"entity already exists: ...","status":"ALREADY_EXISTS"}}
//
// A substring test for "ABORTED" also matches the word appearing anywhere
// else -- inside a `message`, inside a resource name Firestore echoes back,
// or inside an HTML error page from a proxy that never reached Firestore at
// all. Each of those would be read as a statement about the write, which it
// is not.

export type CanonicalStatus =
  | "ABORTED"
  | "ALREADY_EXISTS"
  | "DEADLINE_EXCEEDED"
  | "FAILED_PRECONDITION"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "UNAUTHENTICATED"
  | "UNAVAILABLE";

export type FirestoreApiError = {
  readonly code: number;
  readonly message: string;
  readonly status: string;
};

// google.rpc.Code -> HTTP, from the canonical gRPC/HTTP mapping. A body whose
// declared status cannot produce the HTTP status we actually received did not
// come from Firestore's error path intact, so it is not evidence of anything.
const HTTP_STATUS_FOR_CANONICAL: Readonly<Record<string, number>> = {
  ABORTED: 409,
  ALREADY_EXISTS: 409,
  CANCELLED: 499,
  DATA_LOSS: 500,
  DEADLINE_EXCEEDED: 504,
  FAILED_PRECONDITION: 400,
  INTERNAL: 500,
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  OUT_OF_RANGE: 400,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  UNAUTHENTICATED: 401,
  UNAVAILABLE: 503,
  UNIMPLEMENTED: 501,
  UNKNOWN: 500,
};

// An error body is small. Anything larger is a proxy page or a truncated
// stream, and parsing megabytes to look for a status is its own denial of
// service.
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const CANONICAL_STATUS_PATTERN = /^[A-Z][A-Z_]{1,63}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

// Returns the decoded error only when the envelope is intact AND internally
// consistent with the HTTP status. Every other input returns undefined, which
// callers must treat as "this response proves nothing".
export function parseFirestoreApiError(
  httpStatus: number,
  body: string,
): FirestoreApiError | undefined {
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    return undefined;
  }
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_ERROR_BODY_BYTES) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return undefined;
  }

  const envelope = asRecord(decoded);
  const error = envelope === undefined ? undefined : asRecord(envelope.error);
  if (error === undefined) {
    return undefined;
  }

  const status = error.status;
  const code = error.code;
  if (typeof status !== "string" || !CANONICAL_STATUS_PATTERN.test(status)) {
    return undefined;
  }
  if (!Number.isInteger(code)) {
    return undefined;
  }
  // The status must be one we know how to map. An unrecognised status is not
  // assumed benign; it is simply not decoded.
  const expectedHttp = HTTP_STATUS_FOR_CANONICAL[status];
  if (expectedHttp === undefined) {
    return undefined;
  }
  // Three-way agreement: transport status, envelope code, and canonical
  // mapping must all say the same thing.
  if (code !== httpStatus || expectedHttp !== httpStatus) {
    return undefined;
  }

  const message = typeof error.message === "string" ? error.message : "";
  return { code, message, status };
}

// The only question callers should ask: did Firestore state exactly this?
export function firestoreErrorIs(
  httpStatus: number,
  body: string,
  expected: CanonicalStatus,
): boolean {
  const parsed = parseFirestoreApiError(httpStatus, body);
  return parsed !== undefined && parsed.status === expected;
}
