import { cancelledError } from "../errors.ts";

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelledError();
  if (milliseconds <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(cancelledError());
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export function retryDelayMs(
  headers: Record<string, string | undefined>,
  attempt: number,
  maximumMs = 30_000,
): number {
  const retryAfterMs = readHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, maximumMs);
  }

  const retryAfter = readHeader(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, maximumMs);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maximumMs);
  }

  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), maximumMs);
}

function readHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
