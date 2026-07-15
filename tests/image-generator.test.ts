import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { CodexAuth } from "../src/auth/codex-auth.ts";
import { DefaultImageGenerator } from "../src/image-generator.ts";
import { ExtensionError } from "../src/errors.ts";
import type { GeneratedImageData } from "../src/types.ts";

const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]).toString("base64");
const auth: CodexAuth = {
  token: "token",
  accountId: "account",
  headers: {},
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/work/project",
    agentDir: "/home/me/.pi/agent",
    sessionId: "session",
    projectTrusted: true,
    modelRegistry: {},
    ...overrides,
  };
}

test("DefaultImageGenerator resolves auth, generates, validates, and saves one PNG", async () => {
  const events: string[] = [];
  const generator = new DefaultImageGenerator({
    resolveAuth: async () => {
      events.push("auth");
      return auth;
    },
    client: {
      generate: async (request): Promise<GeneratedImageData> => {
        events.push(`generate:${request.quality}:${request.size}`);
        return { base64: PNG_BASE64, created: 123, quality: "medium", size: "1024x1024" };
      },
      edit: async () => {
        throw new Error("edit must not run");
      },
    },
    store: {
      save: async (_bytes, desiredPath) => {
        events.push(`save:${desiredPath}`);
        return desiredPath;
      },
    },
  });

  const result = await generator.generate({ prompt: " Fox icon " }, context());

  assert.deepEqual(events, [
    "auth",
    "generate:auto:auto",
    `save:${join("/work/project", ".pi/generated-images/session/fox-icon.png")}`,
  ]);
  assert.equal(result.base64, PNG_BASE64);
  assert.equal(result.savedPath, join("/work/project", ".pi/generated-images/session/fox-icon.png"));
  assert.equal(result.model, "gpt-image-2");
  assert.equal(result.created, 123);
});

test("DefaultImageGenerator can preview without saving and never passes bytes into metadata", async () => {
  let saveCalled = false;
  const generator = new DefaultImageGenerator({
    resolveAuth: async () => auth,
    client: {
      generate: async () => ({ base64: PNG_BASE64 }),
      edit: async () => {
        throw new Error("edit must not run");
      },
    },
    store: {
      save: async () => {
        saveCalled = true;
        return "unexpected";
      },
    },
  });

  const result = await generator.generate({ prompt: "fox", save: "none" }, context());

  assert.equal(result.savedPath, undefined);
  assert.equal(saveCalled, false);
});

test("DefaultImageGenerator loads approved references before auth and calls edit", async () => {
  const events: string[] = [];
  const generator = new DefaultImageGenerator({
    resolveAuth: async () => {
      events.push("auth");
      return auth;
    },
    client: {
      generate: async () => {
        throw new Error("generation must not run");
      },
      edit: async (request) => {
        events.push(`edit:${request.images.join(",")}`);
        return { base64: PNG_BASE64 };
      },
    },
    store: { save: async () => "unused" },
  });
  const referenceImages = {
    count: 1,
    displayPaths: ["/work/project/source.png"],
    load: async (approved: boolean) => {
      events.push(`load:${approved}`);
      return [{ dataUrl: "data:image/png;base64,c291cmNl", mimeType: "image/png" }];
    },
  };

  await generator.generate(
    { prompt: "Replace only the background", referencedImagePaths: ["source.png"], save: "none" },
    context({ referenceImages, referenceUploadApproved: true }),
  );

  assert.deepEqual(events, [
    "load:true",
    "auth",
    "edit:data:image/png;base64,c291cmNl",
  ]);
});

test("DefaultImageGenerator rejects missing reference approval before auth", async () => {
  let authCalled = false;
  const generator = new DefaultImageGenerator({
    resolveAuth: async () => {
      authCalled = true;
      return auth;
    },
    client: {
      generate: async () => ({ base64: PNG_BASE64 }),
      edit: async () => ({ base64: PNG_BASE64 }),
    },
    store: { save: async () => "unused" },
  });
  const referenceImages = {
    count: 1,
    displayPaths: ["/work/project/source.png"],
    load: async (approved: boolean) => {
      if (!approved) throw new ExtensionError("INPUT_IMAGE_APPROVAL_REQUIRED", "approval required");
      return [];
    },
  };

  await assert.rejects(
    generator.generate(
      { prompt: "edit", referencedImagePaths: ["source.png"], save: "none" },
      context({ referenceImages, referenceUploadApproved: false }),
    ),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "INPUT_IMAGE_APPROVAL_REQUIRED",
  );
  assert.equal(authCalled, false);
});

test("DefaultImageGenerator validates the request before auth or network", async () => {
  let authCalled = false;
  const generator = new DefaultImageGenerator({
    resolveAuth: async () => {
      authCalled = true;
      return auth;
    },
    client: {
      generate: async () => ({ base64: PNG_BASE64 }),
      edit: async () => {
        throw new Error("edit must not run");
      },
    },
    store: { save: async () => "unused" },
  });

  await assert.rejects(
    generator.generate({ prompt: "   " }, context()),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );
  assert.equal(authCalled, false);
});
