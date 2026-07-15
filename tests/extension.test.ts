import assert from "node:assert/strict";
import test from "node:test";

import { createCodexImageExtension } from "../index.ts";
import type { GeneratedImage, ImageGenerator } from "../src/image-generator.ts";

function fakePi() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let tool: any;
	return {
		api: {
			on(name: string, handler: (...args: any[]) => unknown) {
				handlers.set(name, handler);
			},
			registerTool(definition: unknown) {
				tool = definition;
			},
		},
		handlers,
		get tool() {
			return tool;
		},
	};
}

function toolContext(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/work/project",
		hasUI: false,
		modelRegistry: {},
		sessionManager: { getSessionId: () => "session-id" },
		isProjectTrusted: () => true,
		ui: { confirm: async () => false },
		...overrides,
	};
}

test("package extension registers codex_generate_image", async () => {
	const image: GeneratedImage = {
		base64: "png-base64",
		mimeType: "image/png",
		model: "gpt-image-2",
		savedPath: "/work/project/.pi/generated-images/session-id/fox.png",
		quality: "high",
		size: "1024x1024",
	};
	const calls: unknown[] = [];
	const generator: ImageGenerator = {
		generate: async (request, context) => {
			calls.push({ request, context });
			return image;
		},
	};
	const pi = fakePi();

	createCodexImageExtension(generator)(pi.api as never);

	assert.equal(pi.tool.name, "codex_generate_image");
	assert.equal(pi.tool.label, "Codex Generate Image");
	assert.equal(pi.tool.parameters.properties.referencedImagePaths.minItems, 0);
	assert.equal(pi.tool.parameters.properties.referencedImagePaths.maxItems, 5);

	const result = await pi.tool.execute(
		"call-id",
		{ prompt: "fox", save: "auto", quality: "high", size: "1024x1024" },
		undefined,
		undefined,
		toolContext(),
	);

	assert.equal(calls.length, 1);
	assert.deepEqual(result.content, [
		{
			type: "text",
			text: "Generated PNG with gpt-image-2 and saved it to /work/project/.pi/generated-images/session-id/fox.png.",
		},
		{ type: "image", data: "png-base64", mimeType: "image/png" },
	]);
	assert.deepEqual(result.details, {
		model: "gpt-image-2",
		mimeType: "image/png",
		savedPath: image.savedPath,
		quality: "high",
		size: "1024x1024",
	});
	assert.equal(JSON.stringify(result.details).includes("png-base64"), false);
});

test("extension plans references and confirms local image upload before editing", async () => {
	const approvals: string[] = [];
	const generatedContexts: unknown[] = [];
	const referencePlan = {
		count: 1,
		displayPaths: ["/work/project/source.png"],
		load: async () => [
			{ dataUrl: "data:image/png;base64,c291cmNl", mimeType: "image/png" },
		],
	};
	const planner = {
		plan: async (paths: readonly string[]) => {
			assert.deepEqual(paths, ["source.png"]);
			return referencePlan;
		},
	};
	const generator: ImageGenerator = {
		generate: async (_request, context) => {
			generatedContexts.push(context);
			return { base64: "edited", mimeType: "image/png", model: "gpt-image-2" };
		},
	};
	const pi = fakePi();
	createCodexImageExtension(generator, planner)(pi.api as never);

	const result = await pi.tool.execute(
		"call-id",
		{
			prompt: "replace background",
			referencedImagePaths: ["source.png"],
			save: "none",
		},
		undefined,
		undefined,
		toolContext({
			hasUI: true,
			ui: {
				confirm: async (title: string, message: string) => {
					approvals.push(`${title}\n${message}`);
					return true;
				},
			},
		}),
	);

	assert.equal(approvals.length, 1);
	assert.match(approvals[0]!, /Upload 1 local image/);
	assert.match(approvals[0]!, /source\.png/);
	assert.equal((generatedContexts[0] as any).referenceImages, referencePlan);
	assert.equal((generatedContexts[0] as any).referenceUploadApproved, true);
	assert.match(result.content[0].text, /^Edited PNG/);
	assert.equal(JSON.stringify(result.details).includes("source.png"), false);
	assert.equal(JSON.stringify(result.details).includes("c291cmNl"), false);
});

test("extension treats an empty reference array as generation without upload approval", async () => {
	let plannerCalled = false;
	let generatedRequest: any;
	const generator: ImageGenerator = {
		generate: async (request) => {
			generatedRequest = request;
			return {
				base64: "generated",
				mimeType: "image/png",
				model: "gpt-image-2",
			};
		},
	};
	const planner = {
		plan: async () => {
			plannerCalled = true;
			throw new Error("planner must not run");
		},
	};
	const pi = fakePi();
	createCodexImageExtension(generator, planner)(pi.api as never);

	const result = await pi.tool.execute(
		"call-id",
		{ prompt: "new fox", referencedImagePaths: [], save: "none" },
		undefined,
		undefined,
		toolContext(),
	);

	assert.equal(plannerCalled, false);
	assert.equal(generatedRequest.referencedImagePaths, undefined);
	assert.match(result.content[0].text, /^Generated PNG/);
});

test("extension rejects local reference uploads in headless mode", async () => {
	let generatorCalled = false;
	const generator: ImageGenerator = {
		generate: async () => {
			generatorCalled = true;
			return {
				base64: "unexpected",
				mimeType: "image/png",
				model: "gpt-image-2",
			};
		},
	};
	const planner = {
		plan: async () => ({
			count: 1,
			displayPaths: ["/work/project/source.png"],
			load: async () => [],
		}),
	};
	const pi = fakePi();
	createCodexImageExtension(generator, planner)(pi.api as never);

	await assert.rejects(
		pi.tool.execute(
			"call-id",
			{ prompt: "edit", referencedImagePaths: ["source.png"] },
			undefined,
			undefined,
			toolContext(),
		),
		/INPUT_IMAGE_APPROVAL_REQUIRED/,
	);
	assert.equal(generatorCalled, false);
});

test("extension requires UI approval for an absolute path outside safe roots", async () => {
	const approvals: string[] = [];
	const generator: ImageGenerator = {
		generate: async (_request, context) => {
			const image: GeneratedImage = {
				base64: "png",
				mimeType: "image/png",
				model: "gpt-image-2",
			};
			if (context.externalOutputPathApproved) image.savedPath = "/tmp/fox.png";
			return image;
		},
	};
	const pi = fakePi();
	createCodexImageExtension(generator)(pi.api as never);

	const result = await pi.tool.execute(
		"call-id",
		{ prompt: "fox", outputPath: "/tmp/fox.png" },
		undefined,
		undefined,
		toolContext({
			hasUI: true,
			ui: {
				confirm: async (_title: string, message: string) => {
					approvals.push(message);
					return true;
				},
			},
		}),
	);

	assert.equal(approvals.length, 1);
	assert.equal(result.details.savedPath, "/tmp/fox.png");
});
