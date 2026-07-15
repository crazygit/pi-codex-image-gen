import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionError } from "../src/errors.ts";
import { abortableSleep, retryDelayMs } from "../src/runtime/retry.ts";

test("retryDelayMs honors provider headers and caps unreasonable delays", () => {
  assert.equal(retryDelayMs({ "retry-after-ms": "250" }, 1), 250);
  assert.equal(retryDelayMs({ "Retry-After": "2" }, 1), 2_000);
  assert.equal(retryDelayMs({ "retry-after": "999999" }, 1), 30_000);
  assert.equal(retryDelayMs({}, 1), 1_000);
  assert.equal(retryDelayMs({}, 2), 2_000);
});

test("abortableSleep rejects immediately when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    abortableSleep(10_000, controller.signal),
    (error: unknown) => error instanceof ExtensionError && error.code === "CANCELLED",
  );
});
