import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { ExtensionError } from "../src/errors.ts";
import { ImageStore, decodePngBase64 } from "../src/output/image-store.ts";
import { resolveOutputPlan } from "../src/output/paths.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codex-image-gen-test-"));
}

function desiredPath(plan: ReturnType<typeof resolveOutputPlan>): string {
  assert.equal(plan.save, true);
  if (!plan.save) throw new Error("Expected a saved output plan");
  return plan.desiredPath;
}

test("resolveOutputPlan uses the trusted project default for save=auto", () => {
  const plan = resolveOutputPlan(
    { prompt: "Red fox at dawn", save: "auto" },
    {
      cwd: "/work/project",
      agentDir: "/home/me/.pi/agent",
      sessionId: "session:123",
      projectTrusted: true,
    },
  );

  assert.equal(desiredPath(plan), resolve("/work/project/.pi/generated-images/session-123/red-fox-at-dawn.png"));
});

test("resolveOutputPlan keeps untrusted auto output in the global agent directory", () => {
  const plan = resolveOutputPlan(
    { prompt: "Red fox", save: "auto" },
    {
      cwd: "/untrusted/project",
      agentDir: "/home/me/.pi/agent",
      sessionId: "abc",
      projectTrusted: false,
    },
  );

  assert.equal(desiredPath(plan), resolve("/home/me/.pi/agent/generated-images/abc/red-fox.png"));
});

test("resolveOutputPlan rejects untrusted project saves and path traversal", () => {
  const untrusted = {
    cwd: "/work/project",
    agentDir: "/home/me/.pi/agent",
    sessionId: "abc",
    projectTrusted: false,
  };
  assert.throws(
    () => resolveOutputPlan({ prompt: "fox", save: "project" }, untrusted),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );

  assert.throws(
    () =>
      resolveOutputPlan(
        { prompt: "fox", outputPath: "../outside.png" },
        { ...untrusted, projectTrusted: true },
      ),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );
});

test("resolveOutputPlan honors explicit paths only inside an approved root", () => {
  const context = {
    cwd: "/work/project",
    agentDir: "/home/me/.pi/agent",
    sessionId: "abc",
    projectTrusted: true,
  };
  assert.equal(
    desiredPath(resolveOutputPlan({ prompt: "fox", outputPath: "assets/hero.png" }, context)),
    "/work/project/assets/hero.png",
  );
  assert.equal(
    desiredPath(
      resolveOutputPlan(
        { prompt: "fox", outputPath: "/tmp/export.png" },
        { ...context, externalOutputPathApproved: true },
      ),
    ),
    "/tmp/export.png",
  );
  assert.throws(
    () => resolveOutputPlan({ prompt: "fox", outputPath: "/tmp/export.png" }, context),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => resolveOutputPlan({ prompt: "fox", outputPath: "hero.png", save: "none" }, context),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );
});

test("resolveOutputPlan rejects a symlink escape from a trusted project", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  await symlink(outside, join(project, "linked"));

  assert.throws(
    () =>
      resolveOutputPlan(
        { prompt: "fox", outputPath: "linked/fox.png" },
        {
          cwd: project,
          agentDir: join(root, "agent"),
          sessionId: "abc",
          projectTrusted: true,
        },
      ),
    (error: unknown) => error instanceof ExtensionError && error.code === "INVALID_REQUEST",
  );
});

test("ImageStore revalidates the approved root after path resolution", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const images = join(project, "images");
  const outside = join(root, "outside");
  await mkdir(images, { recursive: true });
  await mkdir(outside);
  const plan = resolveOutputPlan(
    { prompt: "fox", outputPath: "images/fox.png" },
    {
      cwd: project,
      agentDir: join(root, "agent"),
      sessionId: "abc",
      projectTrusted: true,
    },
  );
  if (!plan.save) throw new Error("Expected saved output plan");
  await rm(images, { recursive: true });
  await symlink(outside, images);

  await assert.rejects(
    new ImageStore().save(PNG, plan.desiredPath, undefined, plan.approvedRoot),
    (error: unknown) => error instanceof ExtensionError && error.code === "SAVE_FAILED",
  );
  await assert.rejects(readFile(join(outside, "fox.png")));
});

test("ImageStore rejects replacement of the planned approved root", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const movedProject = join(root, "project-moved");
  const outside = join(root, "outside");
  await mkdir(join(project, "images"), { recursive: true });
  await mkdir(outside);
  const plan = resolveOutputPlan(
    { prompt: "fox", outputPath: "images/fox.png" },
    {
      cwd: project,
      agentDir: join(root, "agent"),
      sessionId: "abc",
      projectTrusted: true,
    },
  );
  if (!plan.save) throw new Error("Expected saved output plan");
  await rename(project, movedProject);
  await symlink(outside, project);

  await assert.rejects(
    new ImageStore().save(PNG, plan.desiredPath, undefined, plan.approvedRoot),
    (error: unknown) => error instanceof ExtensionError && error.code === "SAVE_FAILED",
  );
  await assert.rejects(readFile(join(outside, "images", "fox.png")));
});

test("decodePngBase64 validates canonical base64, decoded size, and PNG signature", () => {
  assert.deepEqual(decodePngBase64(PNG.toString("base64")), PNG);
  assert.throws(
    () => decodePngBase64("%%%"),
    (error: unknown) => error instanceof ExtensionError && error.code === "NO_IMAGE",
  );
  assert.throws(
    () => decodePngBase64(Buffer.from("not png").toString("base64")),
    (error: unknown) => error instanceof ExtensionError && error.code === "NO_IMAGE",
  );
  assert.throws(
    () => decodePngBase64(Buffer.alloc(16).toString("base64"), 8),
    (error: unknown) => error instanceof ExtensionError && error.code === "NO_IMAGE",
  );
});

test("ImageStore writes atomically and allocates deterministic collision suffixes", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const desiredPath = join(root, "images", "fox.png");
  await mkdir(join(root, "images"), { recursive: true });
  await writeFile(desiredPath, "existing");
  const store = new ImageStore();

  const first = await store.save(PNG, desiredPath);
  const second = await store.save(PNG, desiredPath);

  assert.equal(first, join(root, "images", "fox-2.png"));
  assert.equal(second, join(root, "images", "fox-3.png"));
  assert.deepEqual(await readFile(first), PNG);
  assert.equal((await readFile(desiredPath, "utf8")), "existing");
});

test("ImageStore queues the allocated collision path against other Pi file mutations", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const desiredPath = join(root, "fox.png");
  const collisionPath = join(root, "fox-2.png");
  await writeFile(desiredPath, "existing");

  let releaseMutation!: () => void;
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    mutationStarted = resolveStarted;
  });
  const release = new Promise<void>((resolveRelease) => {
    releaseMutation = resolveRelease;
  });
  const competingMutation = withFileMutationQueue(collisionPath, async () => {
    mutationStarted();
    await release;
    await writeFile(collisionPath, "other mutation");
  });
  await started;

  let collisionAttempted!: () => void;
  const attempted = new Promise<void>((resolveAttempted) => {
    collisionAttempted = resolveAttempted;
  });
  const store = new ImageStore(async (path, operation) => {
    if (basename(path) === "fox-2.png") collisionAttempted();
    return withFileMutationQueue(path, operation);
  });
  const savePromise = store.save(PNG, desiredPath);
  await attempted;
  releaseMutation();
  await competingMutation;
  const savedPath = await savePromise;

  assert.equal(savedPath, join(root, "fox-3.png"));
  assert.equal(await readFile(collisionPath, "utf8"), "other mutation");
});

test("ImageStore normalizes directory preparation failures", async () => {
  await assert.rejects(
    new ImageStore().save(PNG, "/dev/null/fox.png"),
    (error: unknown) => error instanceof ExtensionError && error.code === "SAVE_FAILED",
  );
});

test("ImageStore serializes concurrent saves without overwriting", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const desiredPath = join(root, "same.png");
  const store = new ImageStore();

  const paths = await Promise.all([store.save(PNG, desiredPath), store.save(PNG, desiredPath)]);

  assert.deepEqual(paths.sort(), [desiredPath, join(root, "same-2.png")].sort());
  assert.deepEqual(await readFile(paths[0]!), PNG);
  assert.deepEqual(await readFile(paths[1]!), PNG);
});
