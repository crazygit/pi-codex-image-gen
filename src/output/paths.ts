import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { ExtensionError } from "../errors.ts";
import type { GenerateImageRequest } from "../types.ts";

export interface OutputContext {
  cwd: string;
  agentDir: string;
  sessionId: string;
  projectTrusted: boolean;
  externalOutputPathApproved?: boolean | undefined;
}

export interface ApprovedRootAnchor {
  canonicalPath: string;
  device: number;
  inode: number;
}

export type OutputPlan =
  | { save: false }
  | {
      save: true;
      desiredPath: string;
      approvedRoot: ApprovedRootAnchor;
    };

export function requiresExternalOutputPathApproval(
  request: GenerateImageRequest,
  context: OutputContext,
): boolean {
  if (!request.outputPath) return false;
  const trimmed = request.outputPath.trim().replace(/^@/, "");
  if (!isAbsolute(trimmed)) return false;
  const resolvedPath = resolve(trimmed);
  return !(
    (context.projectTrusted && isWithin(context.cwd, resolvedPath)) ||
    isWithin(context.agentDir, resolvedPath)
  );
}

export function resolveOutputPlan(request: GenerateImageRequest, context: OutputContext): OutputPlan {
  const saveMode = request.save ?? "auto";
  if (saveMode === "none") {
    if (request.outputPath !== undefined) {
      throw invalidPath("outputPath cannot be combined with save=none.");
    }
    return { save: false };
  }

  if (request.outputPath !== undefined) {
    const explicit = resolveExplicitPath(request.outputPath, context);
    return { save: true, ...explicit };
  }

  const session = sanitizePart(context.sessionId, "session");
  const filename = `${sanitizePart(request.prompt, "image")}.png`;
  if (saveMode === "project" && !context.projectTrusted) {
    throw invalidPath("Project output is disabled because the current project is not trusted.");
  }

  const useProject = saveMode === "project" || (saveMode === "auto" && context.projectTrusted);
  const safeRoot = useProject ? context.cwd : context.agentDir;
  const root = useProject
    ? resolve(context.cwd, ".pi", "generated-images", session)
    : resolve(context.agentDir, "generated-images", session);
  const desiredPath = resolve(root, filename);
  if (!isWithin(safeRoot, desiredPath)) {
    throw invalidPath("The generated output path escapes its approved root through a symbolic link.");
  }
  return { save: true, desiredPath, approvedRoot: captureApprovedRoot(safeRoot) };
}

function resolveExplicitPath(
  outputPath: string,
  context: OutputContext,
): { desiredPath: string; approvedRoot: ApprovedRootAnchor } {
  const trimmed = outputPath.trim().replace(/^@/, "");
  if (!trimmed) throw invalidPath("outputPath must not be empty.");

  const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(context.cwd, trimmed);
  if (!resolvedPath.toLowerCase().endsWith(".png")) {
    throw invalidPath("outputPath must end in .png because v1 writes PNG files only.");
  }

  const inProject = isWithin(context.cwd, resolvedPath);
  const inAgentDir = isWithin(context.agentDir, resolvedPath);
  if (!isAbsolute(trimmed)) {
    if (!context.projectTrusted || !inProject) {
      throw invalidPath("Relative outputPath is allowed only inside a trusted project.");
    }
    return { desiredPath: resolvedPath, approvedRoot: captureApprovedRoot(context.cwd) };
  }

  if (inProject && context.projectTrusted) {
    return { desiredPath: resolvedPath, approvedRoot: captureApprovedRoot(context.cwd) };
  }
  if (inAgentDir) {
    return { desiredPath: resolvedPath, approvedRoot: captureApprovedRoot(context.agentDir) };
  }
  if (context.externalOutputPathApproved) {
    return { desiredPath: resolvedPath, approvedRoot: captureApprovedRoot(dirname(resolvedPath)) };
  }
  throw invalidPath("Writing to this absolute outputPath requires explicit approval.");
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(canonicalizeForContainment(root), canonicalizeForContainment(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function canonicalizeForContainment(path: string): string {
  let existing = resolve(path);
  const missingParts: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(basename(existing));
    existing = parent;
  }

  try {
    return resolve(realpathSync.native(existing), ...missingParts);
  } catch {
    return resolve(path);
  }
}

function captureApprovedRoot(path: string): ApprovedRootAnchor {
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  try {
    const canonicalPath = realpathSync.native(existing);
    const identity = statSync(canonicalPath);
    return { canonicalPath, device: identity.dev, inode: identity.ino };
  } catch {
    throw invalidPath("The approved output root is not accessible.");
  }
}

function sanitizePart(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return sanitized || fallback;
}

function invalidPath(message: string): ExtensionError {
  return new ExtensionError("INVALID_REQUEST", message);
}
