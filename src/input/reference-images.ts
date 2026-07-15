import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
	resizeImage,
	type ResizedImage,
} from "@earendil-works/pi-coding-agent";

import { ExtensionError, cancelledError } from "../errors.ts";

const MAX_REFERENCE_IMAGES = 5;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 20 * 1024 * 1024;
const MAX_TOTAL_DATA_URL_CHARS = 60 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 16_384;
const MAX_SOURCE_PIXELS = 40_000_000;

export type ImageNormalizer = (
	bytes: Uint8Array,
	mimeType: string,
	signal?: AbortSignal,
) => Promise<ResizedImage | null>;

export interface ReferencePathContext {
	cwd: string;
	projectTrusted: boolean;
}

export interface ResolvedReferenceImage {
	dataUrl: string;
	mimeType: string;
}

export interface ReferenceImagePlanning {
	plan(
		paths: readonly string[],
		context: ReferencePathContext,
	): Promise<PlannedReferenceImages>;
}

export interface PlannedReferenceImages {
	readonly count: number;
	readonly displayPaths: readonly string[];
	load(
		approved: boolean,
		signal?: AbortSignal,
	): Promise<ResolvedReferenceImage[]>;
}

interface PlannedFile {
	canonicalPath: string;
	device: number;
	inode: number;
	size: number;
	modifiedAtMs: number;
	changedAtMs: number;
}

const defaultNormalizer: ImageNormalizer = (bytes, mimeType) =>
	resizeImage(bytes, mimeType, {
		maxWidth: 16_384,
		maxHeight: 16_384,
		maxBytes: MAX_DATA_URL_CHARS,
		jpegQuality: 90,
	});

export class ReferenceImagePlanner implements ReferenceImagePlanning {
	private readonly normalize: ImageNormalizer;

	constructor(normalize: ImageNormalizer = defaultNormalizer) {
		this.normalize = normalize;
	}

	async plan(
		paths: readonly string[],
		context: ReferencePathContext,
	): Promise<PlannedReferenceImages> {
		if (paths.length === 0) {
			return {
				count: 0,
				displayPaths: [],
				load: async () => [],
			};
		}
		if (paths.length > MAX_REFERENCE_IMAGES) {
			throw new ExtensionError(
				"TOO_MANY_INPUT_IMAGES",
				`At most ${MAX_REFERENCE_IMAGES} reference images can be uploaded in one request.`,
			);
		}

		const projectRoot = context.projectTrusted
			? await realpath(context.cwd).catch(() => resolve(context.cwd))
			: resolve(context.cwd);
		const files: PlannedFile[] = [];
		let totalBytes = 0;
		for (const rawPath of paths) {
			const path = normalizePathArgument(rawPath);
			if (!isAbsolute(path) && !context.projectTrusted) {
				throw new ExtensionError(
					"UNSAFE_INPUT_PATH",
					"Relative reference image paths require a trusted project.",
				);
			}

			const resolvedPath = isAbsolute(path)
				? resolve(path)
				: resolve(context.cwd, path);
			let canonicalPath: string;
			let metadata;
			try {
				canonicalPath = await realpath(resolvedPath);
				metadata = await stat(canonicalPath);
			} catch {
				throw new ExtensionError(
					"INPUT_IMAGE_INVALID",
					"A reference image is missing or unreadable.",
				);
			}

			if (!isAbsolute(path) && !isWithin(projectRoot, canonicalPath)) {
				throw new ExtensionError(
					"UNSAFE_INPUT_PATH",
					"A relative reference image path escapes the trusted project.",
				);
			}
			if (!metadata.isFile()) {
				throw new ExtensionError(
					"INPUT_IMAGE_INVALID",
					"Every reference image must be a regular file.",
				);
			}
			if (metadata.size > MAX_SOURCE_BYTES) {
				throw new ExtensionError(
					"INPUT_IMAGE_TOO_LARGE",
					"A reference image exceeds the 20 MiB source-file limit.",
				);
			}
			totalBytes += metadata.size;
			if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
				throw new ExtensionError(
					"INPUT_IMAGE_TOO_LARGE",
					"Reference images exceed the 50 MiB combined source-file limit.",
				);
			}

			files.push({
				canonicalPath,
				device: metadata.dev,
				inode: metadata.ino,
				size: metadata.size,
				modifiedAtMs: metadata.mtimeMs,
				changedAtMs: metadata.ctimeMs,
			});
		}

		const normalize = this.normalize;
		return {
			count: files.length,
			displayPaths: files.map((file) => file.canonicalPath),
			load: (approved, signal) =>
				loadPlannedFiles(files, normalize, approved, signal),
		};
	}
}

async function loadPlannedFiles(
	files: readonly PlannedFile[],
	normalize: ImageNormalizer,
	approved: boolean,
	signal?: AbortSignal,
): Promise<ResolvedReferenceImage[]> {
	if (!approved) {
		throw new ExtensionError(
			"INPUT_IMAGE_APPROVAL_REQUIRED",
			"Uploading local reference images to Codex requires explicit approval.",
		);
	}

	const images: ResolvedReferenceImage[] = [];
	let totalDataUrlChars = 0;
	for (const file of files) {
		if (signal?.aborted) throw cancelledError();
		const handle = await open(
			file.canonicalPath,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		).catch(() => {
			throw new ExtensionError(
				"INPUT_IMAGE_CHANGED",
				"A reference image changed before upload.",
			);
		});
		try {
			const before = await handle.stat();
			assertUnchanged(file, before);
			const bytes = await handle.readFile();
			const after = await handle.stat();
			assertUnchanged(file, after);
			if (bytes.length !== file.size) throw changedImageError();
			if (signal?.aborted) throw cancelledError();

			const mimeType = detectMimeType(bytes);
			if (!mimeType) {
				throw new ExtensionError(
					"INPUT_IMAGE_INVALID",
					"Reference images must be valid PNG, JPEG, or WebP files.",
				);
			}
			assertSafeImageDimensions(bytes, mimeType);
			const normalized = await withAbort(
				normalize(bytes, mimeType, signal),
				signal,
			);
			if (signal?.aborted) throw cancelledError();
			if (!normalized) {
				throw new ExtensionError(
					"INPUT_IMAGE_INVALID",
					"A reference image could not be decoded safely.",
				);
			}
			const dataUrl = `data:${normalized.mimeType};base64,${normalized.data}`;
			if (dataUrl.length > MAX_DATA_URL_CHARS) {
				throw new ExtensionError(
					"INPUT_IMAGE_TOO_LARGE",
					"A normalized reference image exceeds the 20 MiB request limit.",
				);
			}
			totalDataUrlChars += dataUrl.length;
			if (totalDataUrlChars > MAX_TOTAL_DATA_URL_CHARS) {
				throw new ExtensionError(
					"INPUT_IMAGE_TOO_LARGE",
					"Normalized reference images exceed the combined request-size limit.",
				);
			}
			images.push({ dataUrl, mimeType: normalized.mimeType });
		} finally {
			await handle.close();
		}
	}
	return images;
}

function assertUnchanged(planned: PlannedFile, current: Stats): void {
	if (
		current.dev !== planned.device ||
		current.ino !== planned.inode ||
		current.size !== planned.size ||
		current.mtimeMs !== planned.modifiedAtMs ||
		current.ctimeMs !== planned.changedAtMs
	) {
		throw changedImageError();
	}
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(cancelledError());

	return new Promise<T>((resolveOperation, rejectOperation) => {
		const cancel = () => rejectOperation(cancelledError());
		signal.addEventListener("abort", cancel, { once: true });
		operation.then(resolveOperation, rejectOperation).finally(() => {
			signal.removeEventListener("abort", cancel);
		});
	});
}

function changedImageError(): ExtensionError {
	return new ExtensionError(
		"INPUT_IMAGE_CHANGED",
		"A reference image changed before upload.",
	);
}

function normalizePathArgument(value: string): string {
	const normalized = value.trim().replace(/^@/, "");
	if (!normalized)
		throw new ExtensionError(
			"INPUT_IMAGE_INVALID",
			"Reference image paths must not be empty.",
		);
	return normalized;
}

function isWithin(root: string, candidate: string): boolean {
	const relation = relative(resolve(root), resolve(candidate));
	return (
		relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
	);
}

interface ImageDimensions {
	width: number;
	height: number;
}

function assertSafeImageDimensions(bytes: Uint8Array, mimeType: string): void {
	const dimensions = readImageDimensions(bytes, mimeType);
	if (dimensions === undefined) {
		throw new ExtensionError(
			"INPUT_IMAGE_INVALID",
			"A reference image has invalid dimensions.",
		);
	}

	const { width, height } = dimensions;
	if (width === 0 || height === 0) {
		throw new ExtensionError(
			"INPUT_IMAGE_INVALID",
			"A reference image has invalid dimensions.",
		);
	}
	if (
		width > MAX_SOURCE_DIMENSION ||
		height > MAX_SOURCE_DIMENSION ||
		width * height > MAX_SOURCE_PIXELS
	) {
		throw new ExtensionError(
			"INPUT_IMAGE_TOO_LARGE",
			"A reference image exceeds the safe decoded-dimension limit.",
		);
	}
}

function readImageDimensions(
	bytes: Uint8Array,
	mimeType: string,
): ImageDimensions | undefined {
	switch (mimeType) {
		case "image/png":
			return readPngDimensions(bytes);
		case "image/jpeg":
			return readJpegDimensions(bytes);
		case "image/webp":
			return readWebpDimensions(bytes);
		default:
			return undefined;
	}
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	if (
		bytes.length < 24 ||
		bytes[12] !== 0x49 ||
		bytes[13] !== 0x48 ||
		bytes[14] !== 0x44 ||
		bytes[15] !== 0x52
	) {
		return undefined;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16, false);
	const height = view.getUint32(20, false);
	return width > 0 && height > 0 ? { width, height } : undefined;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	let offset = 2;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		while (bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		offset += 1;
		if (marker === undefined || marker === 0xd9 || marker === 0xda)
			return undefined;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.length) return undefined;

		const segmentLength =
			((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
		if (segmentLength < 2 || offset + segmentLength > bytes.length)
			return undefined;
		if (
			[
				0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
				0xcf,
			].includes(marker)
		) {
			if (segmentLength < 7) return undefined;
			const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
			const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
			return width > 0 && height > 0 ? { width, height } : undefined;
		}
		offset += segmentLength;
	}
	return undefined;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkSize = view.getUint32(offset + 4, true);
		const dataOffset = offset + 8;
		if (matchesAscii(bytes, offset, "VP8X")) {
			if (chunkSize < 10 || dataOffset + 10 > bytes.length) return undefined;
			return {
				width: readUint24Le(bytes, dataOffset + 4) + 1,
				height: readUint24Le(bytes, dataOffset + 7) + 1,
			};
		}
		if (matchesAscii(bytes, offset, "VP8L")) {
			if (
				chunkSize < 5 ||
				dataOffset + 5 > bytes.length ||
				bytes[dataOffset] !== 0x2f
			)
				return undefined;
			const bits = view.getUint32(dataOffset + 1, true);
			return {
				width: (bits & 0x3fff) + 1,
				height: ((bits >>> 14) & 0x3fff) + 1,
			};
		}
		if (matchesAscii(bytes, offset, "VP8 ")) {
			if (
				chunkSize < 10 ||
				dataOffset + 10 > bytes.length ||
				bytes[dataOffset + 3] !== 0x9d ||
				bytes[dataOffset + 4] !== 0x01 ||
				bytes[dataOffset + 5] !== 0x2a
			) {
				return undefined;
			}
			return {
				width: view.getUint16(dataOffset + 6, true) & 0x3fff,
				height: view.getUint16(dataOffset + 8, true) & 0x3fff,
			};
		}

		const nextOffset = dataOffset + chunkSize + (chunkSize % 2);
		if (nextOffset <= offset || nextOffset > bytes.length) return undefined;
		offset = nextOffset;
	}
	return undefined;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] ?? 0) |
		((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16)
	);
}

function matchesAscii(
	bytes: Uint8Array,
	offset: number,
	value: string,
): boolean {
	return [...value].every(
		(character, index) => bytes[offset + index] === character.charCodeAt(0),
	);
}

function detectMimeType(bytes: Uint8Array): string | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 12 &&
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}
