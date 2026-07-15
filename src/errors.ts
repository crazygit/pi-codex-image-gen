export type ExtensionErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "INVALID_REQUEST"
  | "TOO_MANY_INPUT_IMAGES"
  | "INPUT_IMAGE_APPROVAL_REQUIRED"
  | "UNSAFE_INPUT_PATH"
  | "INPUT_IMAGE_CHANGED"
  | "INPUT_IMAGE_INVALID"
  | "INPUT_IMAGE_TOO_LARGE"
  | "RATE_LIMITED"
  | "USAGE_LIMIT"
  | "MODERATION_BLOCKED"
  | "BACKEND_UNAVAILABLE"
  | "NO_IMAGE"
  | "CANCELLED"
  | "SAVE_FAILED";

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: ExtensionErrorCode, message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexImageGenerationError";
    this.code = code;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export function cancelledError(): ExtensionError {
  return new ExtensionError("CANCELLED", "Image generation was cancelled.");
}
