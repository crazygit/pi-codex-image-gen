import assert from "node:assert/strict";
import {
	mkdtemp,
	realpath,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExtensionError } from "../src/errors.ts";
import {
	ReferenceImagePlanner,
	type ImageNormalizer,
} from "../src/input/reference-images.ts";

const VALID_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

const passthroughNormalizer: ImageNormalizer = async (bytes, mimeType) => ({
	data: Buffer.from(bytes).toString("base64"),
	mimeType,
	originalWidth: 1,
	originalHeight: 1,
	width: 1,
	height: 1,
	wasResized: false,
});

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "codex-reference-test-"));
}

function pngHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(24);
	VALID_PNG.copy(bytes, 0, 0, 8);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function jpegHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(21);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	bytes.writeUInt16BE(height, 7);
	bytes.writeUInt16BE(width, 9);
	bytes[11] = 3;
	return bytes;
}

function webpExtendedHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(22, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	bytes.writeUIntLE(width - 1, 24, 3);
	bytes.writeUIntLE(height - 1, 27, 3);
	return bytes;
}

function webpLossyHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(22, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8 ", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	bytes.set([0x9d, 0x01, 0x2a], 23);
	bytes.writeUInt16LE(width, 26);
	bytes.writeUInt16LE(height, 28);
	return bytes;
}

function webpLosslessHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(25);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(17, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8L", 12, "ascii");
	bytes.writeUInt32LE(5, 16);
	bytes[20] = 0x2f;
	bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
	return bytes;
}

function progressiveJpegWithAppHeader(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(27);
	bytes.set([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11,
		0x08,
	]);
	bytes.writeUInt16BE(height, 13);
	bytes.writeUInt16BE(width, 15);
	bytes[17] = 3;
	return bytes;
}

test("ReferenceImagePlanner plans and loads approved project images in order", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = join(root, "first.png");
	const second = join(root, "second.png");
	await writeFile(first, VALID_PNG);
	await writeFile(second, VALID_PNG);
	const planner = new ReferenceImagePlanner(passthroughNormalizer);

	const plan = await planner.plan(["first.png", "second.png"], {
		cwd: root,
		projectTrusted: true,
	});

	assert.equal(plan.count, 2);
	assert.deepEqual(plan.displayPaths, [
		await realpath(first),
		await realpath(second),
	]);
	await assert.rejects(
		plan.load(false),
		(error: unknown) =>
			error instanceof ExtensionError &&
			error.code === "INPUT_IMAGE_APPROVAL_REQUIRED",
	);
	const loaded = await plan.load(true);
	assert.deepEqual(
		loaded.map((image) => image.dataUrl),
		[
			`data:image/png;base64,${VALID_PNG.toString("base64")}`,
			`data:image/png;base64,${VALID_PNG.toString("base64")}`,
		],
	);
});

test("ReferenceImagePlanner decodes a real PNG with the production normalizer", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "pixel.png");
	await writeFile(image, VALID_PNG);
	const plan = await new ReferenceImagePlanner().plan([image], {
		cwd: root,
		projectTrusted: true,
	});

	const [loaded] = await plan.load(true);

	assert.equal(loaded?.mimeType, "image/png");
	assert.match(loaded?.dataUrl ?? "", /^data:image\/png;base64,/);
});

test("ReferenceImagePlanner rejects excessive PNG pixels before decoding", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "oversized.png");
	await writeFile(image, pngHeader(10_000, 5_000));
	let normalizeCalled = false;
	const planner = new ReferenceImagePlanner(async () => {
		normalizeCalled = true;
		return null;
	});
	const plan = await planner.plan([image], { cwd: root, projectTrusted: true });

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_TOO_LARGE",
	);
	assert.equal(normalizeCalled, false);
});

test("ReferenceImagePlanner rejects excessive image dimensions before decoding", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "too-wide.png");
	await writeFile(image, pngHeader(20_000, 1));
	let normalizeCalled = false;
	const planner = new ReferenceImagePlanner(async () => {
		normalizeCalled = true;
		return null;
	});
	const plan = await planner.plan([image], { cwd: root, projectTrusted: true });

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_TOO_LARGE",
	);
	assert.equal(normalizeCalled, false);
});

test("ReferenceImagePlanner rejects excessive JPEG pixels before decoding", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "oversized.jpg");
	await writeFile(image, jpegHeader(10_000, 5_000));
	let normalizeCalled = false;
	const planner = new ReferenceImagePlanner(async () => {
		normalizeCalled = true;
		return null;
	});
	const plan = await planner.plan([image], { cwd: root, projectTrusted: true });

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_TOO_LARGE",
	);
	assert.equal(normalizeCalled, false);
});

test("ReferenceImagePlanner rejects excessive WebP pixels before decoding", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "oversized.webp");
	await writeFile(image, webpExtendedHeader(10_000, 5_000));
	let normalizeCalled = false;
	const planner = new ReferenceImagePlanner(async () => {
		normalizeCalled = true;
		return null;
	});
	const plan = await planner.plan([image], { cwd: root, projectTrusted: true });

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_TOO_LARGE",
	);
	assert.equal(normalizeCalled, false);
});

test("ReferenceImagePlanner rejects zero WebP dimensions before decoding", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "invalid.webp");
	await writeFile(image, webpLossyHeader(0, 1));
	let normalizeCalled = false;
	const planner = new ReferenceImagePlanner(async () => {
		normalizeCalled = true;
		return null;
	});
	const plan = await planner.plan([image], { cwd: root, projectTrusted: true });

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_INVALID",
	);
	assert.equal(normalizeCalled, false);
});

test("ReferenceImagePlanner passes safe JPEG and WebP variants to the normalizer", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const fixtures = [
		["progressive.jpg", progressiveJpegWithAppHeader(32, 24)],
		["lossy.webp", webpLossyHeader(32, 24)],
		["lossless.webp", webpLosslessHeader(32, 24)],
		["extended.webp", webpExtendedHeader(32, 24)],
	] as const;
	for (const [name, bytes] of fixtures)
		await writeFile(join(root, name), bytes);
	const normalizedMimeTypes: string[] = [];
	const planner = new ReferenceImagePlanner(async (bytes, mimeType, signal) => {
		normalizedMimeTypes.push(mimeType);
		return passthroughNormalizer(bytes, mimeType, signal);
	});
	const plan = await planner.plan(
		fixtures.map(([name]) => name),
		{
			cwd: root,
			projectTrusted: true,
		},
	);

	const loaded = await plan.load(true);

	assert.equal(loaded.length, 4);
	assert.deepEqual(normalizedMimeTypes, [
		"image/jpeg",
		"image/webp",
		"image/webp",
		"image/webp",
	]);
});

test("ReferenceImagePlanner enforces exact dimension and pixel boundaries", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const maximumDimension = join(root, "maximum-dimension.png");
	const maximumPixels = join(root, "maximum-pixels.png");
	const overDimension = join(root, "over-dimension.png");
	const overPixels = join(root, "over-pixels.png");
	await writeFile(maximumDimension, pngHeader(16_384, 1));
	await writeFile(maximumPixels, pngHeader(8_000, 5_000));
	await writeFile(overDimension, pngHeader(16_385, 1));
	await writeFile(overPixels, pngHeader(8_001, 5_000));
	const planner = new ReferenceImagePlanner(passthroughNormalizer);

	const allowed = await planner.plan([maximumDimension, maximumPixels], {
		cwd: root,
		projectTrusted: true,
	});
	assert.equal((await allowed.load(true)).length, 2);
	for (const image of [overDimension, overPixels]) {
		const rejected = await planner.plan([image], {
			cwd: root,
			projectTrusted: true,
		});
		await assert.rejects(
			rejected.load(true),
			(error: unknown) =>
				error instanceof ExtensionError &&
				error.code === "INPUT_IMAGE_TOO_LARGE",
		);
	}
});

test("ReferenceImagePlanner accepts five images and treats zero images as an empty plan", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "image.png");
	await writeFile(image, VALID_PNG);
	const planner = new ReferenceImagePlanner(passthroughNormalizer);

	const five = await planner.plan([image, image, image, image, image], {
		cwd: root,
		projectTrusted: true,
	});
	const empty = await planner.plan([], { cwd: root, projectTrusted: true });

	assert.equal(five.count, 5);
	assert.equal((await five.load(true)).length, 5);
	assert.equal(empty.count, 0);
	assert.deepEqual(await empty.load(false), []);
});

test("ReferenceImagePlanner rejects more than five images before file access", async () => {
	const planner = new ReferenceImagePlanner(passthroughNormalizer);
	await assert.rejects(
		planner.plan(["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"], {
			cwd: "/does-not-matter",
			projectTrusted: true,
		}),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "TOO_MANY_INPUT_IMAGES",
	);
});

test("ReferenceImagePlanner rejects relative paths in an untrusted project", async () => {
	const planner = new ReferenceImagePlanner(passthroughNormalizer);
	await assert.rejects(
		planner.plan(["private.png"], { cwd: "/untrusted", projectTrusted: false }),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "UNSAFE_INPUT_PATH",
	);
});

test("planned references reject a file swapped after upload approval", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "image.png");
	const replacement = join(root, "replacement.png");
	await writeFile(image, VALID_PNG);
	await writeFile(
		replacement,
		Buffer.concat([VALID_PNG, Buffer.from("changed")]),
	);
	const plan = await new ReferenceImagePlanner(passthroughNormalizer).plan(
		[image],
		{
			cwd: root,
			projectTrusted: true,
		},
	);
	await rename(replacement, image);

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_CHANGED",
	);
});

test("planned references reject same-inode content changes even when size and mtime are restored", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "image.png");
	await writeFile(image, VALID_PNG);
	const original = await stat(image);
	const plan = await new ReferenceImagePlanner(passthroughNormalizer).plan(
		[image],
		{
			cwd: root,
			projectTrusted: true,
		},
	);
	const changed = Buffer.from(VALID_PNG);
	changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
	await writeFile(image, changed);
	await utimes(image, original.atime, original.mtime);

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_CHANGED",
	);
});

test("planned references observe cancellation during normalization", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "image.png");
	await writeFile(image, VALID_PNG);
	let normalizationStarted!: () => void;
	const started = new Promise<void>((resolveStarted) => {
		normalizationStarted = resolveStarted;
	});
	const normalizer: ImageNormalizer = async (bytes, mimeType, signal) => {
		normalizationStarted();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		if (signal?.aborted) return null;
		return passthroughNormalizer(bytes, mimeType, signal);
	};
	const plan = await new ReferenceImagePlanner(normalizer).plan([image], {
		cwd: root,
		projectTrusted: true,
	});
	const controller = new AbortController();
	const loading = plan.load(true, controller.signal);
	await started;
	controller.abort();

	await assert.rejects(
		loading,
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "CANCELLED",
	);
});

test("planned references reject unsupported or corrupt images", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = join(root, "fake.png");
	await writeFile(image, "not an image");
	const plan = await new ReferenceImagePlanner(passthroughNormalizer).plan(
		[image],
		{
			cwd: root,
			projectTrusted: true,
		},
	);

	await assert.rejects(
		plan.load(true),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "INPUT_IMAGE_INVALID",
	);
});
