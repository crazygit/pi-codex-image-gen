import { constants } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { ExtensionError, cancelledError } from "../errors.ts";
import type { ApprovedRootAnchor } from "./paths.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function decodePngBase64(value: string, maximumBytes = DEFAULT_MAX_IMAGE_BYTES): Buffer {
  const encoded = value.trim();
  const estimatedBytes = Math.floor((encoded.length * 3) / 4);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
    estimatedBytes > maximumBytes + 2
  ) {
    throw invalidImage();
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== encoded || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalidImage();
  }
  return bytes;
}

type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

export class ImageStore {
  private readonly queue: MutationQueue;

  constructor(queue: MutationQueue = withFileMutationQueue) {
    this.queue = queue;
  }

  async save(
    bytes: Buffer,
    desiredPath: string,
    signal?: AbortSignal,
    plannedRoot?: ApprovedRootAnchor,
  ): Promise<string> {
    try {
      if (signal?.aborted) throw cancelledError();
      const root = plannedRoot ?? (await captureCurrentAnchor(dirname(desiredPath)));
      await assertAnchorUnchanged(root);
      await mkdir(dirname(desiredPath), { recursive: true });
      await assertAnchorUnchanged(root);

      const directory = await realpath(dirname(desiredPath));
      assertWithin(root.canonicalPath, directory);
      const directoryStat = await stat(directory);
      const directoryIdentity = { device: directoryStat.dev, inode: directoryStat.ino };
      const canonicalDesiredPath = join(directory, basename(desiredPath));
      const canonicalSavedPath = await writeToAvailablePath(
        bytes,
        canonicalDesiredPath,
        root,
        directoryIdentity,
        this.queue,
        signal,
      );
      return join(dirname(desiredPath), basename(canonicalSavedPath));
    } catch (error) {
      if (error instanceof ExtensionError) throw error;
      throw new ExtensionError("SAVE_FAILED", "The generated PNG could not be saved.");
    }
  }
}

interface DirectoryIdentity {
  device: number;
  inode: number;
}

async function writeToAvailablePath(
  bytes: Buffer,
  desiredPath: string,
  root: ApprovedRootAnchor,
  directoryIdentity: DirectoryIdentity,
  queue: MutationQueue,
  signal?: AbortSignal,
): Promise<string> {
  const extension = extname(desiredPath);
  const stem = desiredPath.slice(0, desiredPath.length - extension.length);

  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 1 ? desiredPath : `${stem}-${suffix}${extension}`;
    const saved = await queue(candidate, async () =>
      tryInstallCandidate(bytes, candidate, root, directoryIdentity, signal),
    );
    if (saved) return candidate;
  }

  throw new ExtensionError("SAVE_FAILED", "Could not allocate a unique PNG filename.");
}

async function tryInstallCandidate(
  bytes: Buffer,
  finalPath: string,
  root: ApprovedRootAnchor,
  directoryIdentity: DirectoryIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw cancelledError();
  await assertMutationLocation(dirname(finalPath), root, directoryIdentity);

  const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`);
  let installedIdentity: DirectoryIdentity | undefined;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const temporary = await open(temporaryPath, flags, 0o600);
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
      const temporaryStat = await temporary.stat();
      installedIdentity = { device: temporaryStat.dev, inode: temporaryStat.ino };
    } finally {
      await temporary.close();
    }
    if (signal?.aborted) throw cancelledError();
    await assertMutationLocation(dirname(finalPath), root, directoryIdentity);
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    await assertMutationLocation(dirname(finalPath), root, directoryIdentity);
    return true;
  } catch (error) {
    if (installedIdentity) await unlinkIfIdentityMatches(finalPath, installedIdentity);
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function assertMutationLocation(
  directory: string,
  root: ApprovedRootAnchor,
  expectedDirectory: DirectoryIdentity,
): Promise<void> {
  await assertAnchorUnchanged(root);
  const currentDirectory = await realpath(directory);
  assertWithin(root.canonicalPath, currentDirectory);
  const current = await stat(currentDirectory);
  if (current.dev !== expectedDirectory.device || current.ino !== expectedDirectory.inode) {
    throw new ExtensionError("SAVE_FAILED", "The output directory changed while the PNG was being saved.");
  }
}

async function captureCurrentAnchor(path: string): Promise<ApprovedRootAnchor> {
  let existing = resolve(path);
  while (true) {
    try {
      const canonicalPath = await realpath(existing);
      const identity = await stat(canonicalPath);
      return { canonicalPath, device: identity.dev, inode: identity.ino };
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new ExtensionError("SAVE_FAILED", "The output root is not accessible.");
      existing = parent;
    }
  }
}

async function assertAnchorUnchanged(root: ApprovedRootAnchor): Promise<void> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(root.canonicalPath);
  } catch {
    throw new ExtensionError("SAVE_FAILED", "The approved output root changed before the PNG was saved.");
  }
  const current = await stat(canonicalPath);
  if (
    canonicalPath !== root.canonicalPath ||
    current.dev !== root.device ||
    current.ino !== root.inode
  ) {
    throw new ExtensionError("SAVE_FAILED", "The approved output root changed before the PNG was saved.");
  }
}

async function unlinkIfIdentityMatches(path: string, expected: DirectoryIdentity): Promise<void> {
  try {
    const current = await stat(path);
    if (current.dev === expected.device && current.ino === expected.inode) await unlink(path);
  } catch {
    // The failed publication left no matching file to clean up.
  }
}

function assertWithin(root: string, candidate: string): void {
  const relation = relative(resolve(root), resolve(candidate));
  if (relation !== "" && (relation.startsWith("..") || isAbsolute(relation))) {
    throw new ExtensionError("SAVE_FAILED", "The output path escaped its approved root.");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function invalidImage(): ExtensionError {
  return new ExtensionError("NO_IMAGE", "The Codex image service returned invalid or oversized PNG data.");
}
