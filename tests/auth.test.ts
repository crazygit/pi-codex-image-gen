import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionError } from "../src/errors.ts";
import { extractCodexAccountId, resolveCodexAuth } from "../src/auth/codex-auth.ts";

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const accessToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
});

test("extractCodexAccountId reads only the account id from a base64url JWT payload", () => {
  assert.equal(extractCodexAccountId(accessToken), "acct_123");
});

test("extractCodexAccountId rejects malformed tokens without exposing them", () => {
  assert.throws(
    () => extractCodexAccountId("secret-token"),
    (error: unknown) =>
      error instanceof ExtensionError &&
      error.code === "AUTH_INVALID" &&
      !error.message.includes("secret-token"),
  );
});

test("resolveCodexAuth chooses an available Codex model and preserves safe configured headers", async () => {
  const calls: unknown[] = [];
  const codexModel = {
    id: "gpt-5.4",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  };
  const registry = {
    getAvailable: () => [
      { id: "claude", provider: "anthropic", baseUrl: "https://example.com" },
      codexModel,
    ],
    getApiKeyAndHeaders: async (model: unknown) => {
      calls.push(model);
      return {
        ok: true as const,
        apiKey: accessToken,
        headers: { "x-custom": "kept", Authorization: "must-not-win" },
      };
    },
  };

  const auth = await resolveCodexAuth(registry);

  assert.deepEqual(calls, [codexModel]);
  assert.equal(auth.accountId, "acct_123");
  assert.equal(auth.token, accessToken);
  assert.equal(auth.headers["x-custom"], "kept");
  assert.equal(auth.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(auth.headers["ChatGPT-Account-ID"], "acct_123");
  assert.equal(auth.headers.originator, "pi");
  assert.equal(auth.headers["Content-Type"], "application/json");
});

test("resolveCodexAuth reports missing login before resolving credentials", async () => {
  const registry = {
    getAvailable: () => [{ id: "claude", provider: "anthropic" }],
    getApiKeyAndHeaders: async () => {
      throw new Error("must not run");
    },
  };

  await assert.rejects(
    resolveCodexAuth(registry),
    (error: unknown) => error instanceof ExtensionError && error.code === "AUTH_MISSING",
  );
});

test("resolveCodexAuth normalizes registry auth failures", async () => {
  const registry = {
    getAvailable: () => [{ id: "gpt-5.4", provider: "openai-codex" }],
    getApiKeyAndHeaders: async () => ({ ok: false as const, error: "refresh failed with private details" }),
  };

  await assert.rejects(
    resolveCodexAuth(registry),
    (error: unknown) =>
      error instanceof ExtensionError &&
      error.code === "AUTH_INVALID" &&
      error.cause === undefined &&
      !error.message.includes("private details"),
  );
});
