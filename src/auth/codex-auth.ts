import { ExtensionError } from "../errors.ts";

const AUTH_CLAIM = "https://api.openai.com/auth";

interface CodexCarrierModel {
  id: string;
  provider: string;
  baseUrl?: string;
}

interface ResolvedAuth {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

export interface CodexAuth {
  token: string;
  accountId: string;
  headers: Record<string, string>;
}

export interface CodexAuthRegistry<TModel extends CodexCarrierModel> {
  getAvailable(): TModel[];
  getApiKeyAndHeaders(model: TModel): Promise<ResolvedAuth>;
}

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      throw new Error("Malformed JWT");
    }

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload[AUTH_CLAIM];
    if (!auth || typeof auth !== "object") {
      throw new Error("Missing auth claim");
    }

    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.trim().length === 0) {
      throw new Error("Missing account id");
    }
    return accountId;
  } catch {
    throw new ExtensionError(
      "AUTH_INVALID",
      "The OpenAI Codex login token is invalid. Run /login and sign in to ChatGPT Plus/Pro again.",
    );
  }
}

export async function resolveCodexAuth<TModel extends CodexCarrierModel>(
  registry: CodexAuthRegistry<TModel>,
): Promise<CodexAuth> {
  const model = registry
    .getAvailable()
    .filter((candidate) => candidate.provider === "openai-codex")
    .sort((left, right) => left.id.localeCompare(right.id))[0];

  if (!model) {
    throw new ExtensionError(
      "AUTH_MISSING",
      "No ChatGPT Plus/Pro Codex login is available. Run /login and select ChatGPT Plus/Pro (Codex).",
    );
  }

  let resolved: ResolvedAuth;
  try {
    resolved = await registry.getApiKeyAndHeaders(model);
  } catch {
    throw new ExtensionError(
      "AUTH_INVALID",
      "Could not refresh the OpenAI Codex login. Run /login and sign in again.",
    );
  }

  if (!resolved.ok || !resolved.apiKey) {
    throw new ExtensionError(
      "AUTH_INVALID",
      "Could not refresh the OpenAI Codex login. Run /login and sign in again.",
    );
  }

  const token = resolved.apiKey;
  const accountId = extractCodexAccountId(token);
  return {
    token,
    accountId,
    headers: {
      ...resolved.headers,
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-ID": accountId,
      originator: "pi",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
}
