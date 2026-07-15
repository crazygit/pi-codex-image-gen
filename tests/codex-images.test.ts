import assert from "node:assert/strict";
import test from "node:test";

import type { CodexAuth } from "../src/auth/codex-auth.ts";
import {
	CodexImagesClient,
	FetchHttpTransport,
} from "../src/client/codex-images.ts";
import { ExtensionError } from "../src/errors.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/types.ts";

const auth: CodexAuth = {
	token: "private-token",
	accountId: "acct_123",
	headers: {
		Authorization: "Bearer private-token",
		"ChatGPT-Account-ID": "acct_123",
		originator: "pi",
		"Content-Type": "application/json",
		Accept: "application/json",
		"x-configured": "kept",
	},
};

class FakeTransport implements HttpTransport {
	readonly requests: HttpRequest[] = [];
	readonly responses: Array<HttpResponse | Error>;

	constructor(...responses: Array<HttpResponse | Error>) {
		this.responses = [...responses];
	}

	async send(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		const response = this.responses.shift();
		if (!response) throw new Error("No fake response configured");
		if (response instanceof Error) throw response;
		return response;
	}
}

function jsonResponse(
	status: number,
	value: unknown,
	headers: Record<string, string> = {},
): HttpResponse {
	return { status, headers, body: JSON.stringify(value) };
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		assert.fail("Expected valid JSON request body");
	}
}

test("FetchHttpTransport cancels a response with an excessive declared size", async () => {
	const originalFetch = globalThis.fetch;
	let bodyCancelled = false;
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				cancel() {
					bodyCancelled = true;
				},
			}),
			{
				status: 200,
				headers: { "content-length": String(100 * 1024 * 1024) },
			},
		);
	try {
		await assert.rejects(
			new FetchHttpTransport().send({
				method: "POST",
				url: "https://chatgpt.com/backend-api/codex/images/generations",
				headers: {},
				body: "{}",
			}),
		);
		assert.equal(bodyCancelled, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("FetchHttpTransport rejects non-Codex endpoints before fetch", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => {
		fetchCalled = true;
		return new Response("{}");
	};
	try {
		await assert.rejects(
			new FetchHttpTransport().send({
				method: "POST",
				url: "https://example.com/collect-token",
				headers: {},
				body: "{}",
			}),
			/Unexpected Codex image service endpoint/,
		);
		assert.equal(fetchCalled, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("FetchHttpTransport stops reading an excessive streamed response", async () => {
	const originalFetch = globalThis.fetch;
	const chunk = new Uint8Array(1024 * 1024);
	let pulls = 0;
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					if (pulls <= 40) controller.enqueue(chunk);
					else controller.close();
				},
			}),
			{ status: 200 },
		);
	try {
		await assert.rejects(
			new FetchHttpTransport().send({
				method: "POST",
				url: "https://chatgpt.com/backend-api/codex/images/generations",
				headers: {},
				body: "{}",
			}),
		);
		assert.ok(pulls < 40);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("CodexImagesClient calls only the standalone subscription Images endpoint", async () => {
	const transport = new FakeTransport(
		jsonResponse(200, {
			created: 1778832973,
			background: "opaque",
			data: [{ b64_json: "aW1hZ2U=" }],
			quality: "high",
			size: "1536x1024",
		}),
	);
	const client = new CodexImagesClient(transport);

	const result = await client.generate(
		{ prompt: "A red fox", quality: "high", size: "1536x1024" },
		auth,
	);

	assert.deepEqual(parseJson(transport.requests[0]!.body), {
		model: "gpt-image-2",
		prompt: "A red fox",
		background: "auto",
		quality: "high",
		size: "1536x1024",
	});
	assert.equal(
		transport.requests[0]!.url,
		"https://chatgpt.com/backend-api/codex/images/generations",
	);
	assert.equal(transport.requests[0]!.method, "POST");
	assert.equal(
		transport.requests[0]!.headers.Authorization,
		"Bearer private-token",
	);
	assert.equal(
		transport.requests[0]!.headers["ChatGPT-Account-ID"],
		"acct_123",
	);
	assert.equal(transport.requests[0]!.headers["x-configured"], "kept");
	assert.deepEqual(result, {
		base64: "aW1hZ2U=",
		created: 1778832973,
		quality: "high",
		size: "1536x1024",
	});
});

test("CodexImagesClient sends reference images to the standalone edits endpoint", async () => {
	const transport = new FakeTransport(
		jsonResponse(200, {
			created: 1778832974,
			data: [{ b64_json: "ZWRpdGVk" }],
			quality: "high",
			size: "1024x1024",
		}),
	);
	const client = new CodexImagesClient(transport);

	const result = await client.edit(
		{
			prompt: "Keep the fox and replace only the background",
			images: [
				"data:image/png;base64,aW1hZ2Ux",
				"data:image/jpeg;base64,aW1hZ2Uy",
			],
			quality: "high",
			size: "1024x1024",
		},
		auth,
	);

	assert.equal(
		transport.requests[0]!.url,
		"https://chatgpt.com/backend-api/codex/images/edits",
	);
	assert.deepEqual(parseJson(transport.requests[0]!.body), {
		model: "gpt-image-2",
		images: [
			{ image_url: "data:image/png;base64,aW1hZ2Ux" },
			{ image_url: "data:image/jpeg;base64,aW1hZ2Uy" },
		],
		prompt: "Keep the fox and replace only the background",
		background: "auto",
		quality: "high",
		size: "1024x1024",
	});
	assert.equal(result.base64, "ZWRpdGVk");
});

test("CodexImagesClient reports terminal subscription limits without retrying", async () => {
	const transport = new FakeTransport(
		jsonResponse(429, {
			error: { code: "usage_limit_reached", message: "private backend detail" },
		}),
	);
	const client = new CodexImagesClient(transport);

	await assert.rejects(
		client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth),
		(error: unknown) =>
			error instanceof ExtensionError &&
			error.code === "USAGE_LIMIT" &&
			!error.message.includes("private backend detail"),
	);
	assert.equal(transport.requests.length, 1);
});

test("CodexImagesClient treats a monthly-limit message as terminal even with a generic code", async () => {
	const transport = new FakeTransport(
		jsonResponse(429, {
			error: { code: "rate_limit_exceeded", message: "Monthly limit reached" },
		}),
	);
	const client = new CodexImagesClient(transport);

	await assert.rejects(
		client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "USAGE_LIMIT",
	);
	assert.equal(transport.requests.length, 1);
});

test("CodexImagesClient retries a non-terminal 429 using retry-after-ms", async () => {
	const transport = new FakeTransport(
		jsonResponse(
			429,
			{ error: { code: "rate_limit_exceeded" } },
			{ "retry-after-ms": "25" },
		),
		jsonResponse(200, { data: [{ b64_json: "aW1hZ2U=" }] }),
	);
	const sleeps: number[] = [];
	const client = new CodexImagesClient(transport, {
		sleep: async (milliseconds) => {
			sleeps.push(milliseconds);
		},
	});

	await client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth);

	assert.equal(transport.requests.length, 2);
	assert.deepEqual(sleeps, [25]);
});

test("CodexImagesClient retries selected explicit unavailable responses only", async () => {
	const transport = new FakeTransport(
		jsonResponse(503, { error: { code: "temporarily_unavailable" } }),
		jsonResponse(200, { data: [{ b64_json: "aW1hZ2U=" }] }),
	);
	const client = new CodexImagesClient(transport, {
		sleep: async () => undefined,
	});

	await client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth);

	assert.equal(transport.requests.length, 2);
});

test("CodexImagesClient does not retry ambiguous transport or malformed success failures", async (t) => {
	await t.test("transport failure", async () => {
		const transport = new FakeTransport(new Error("socket closed after write"));
		const client = new CodexImagesClient(transport);
		await assert.rejects(
			client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth),
			(error: unknown) =>
				error instanceof ExtensionError && error.code === "BACKEND_UNAVAILABLE",
		);
		assert.equal(transport.requests.length, 1);
	});

	await t.test("malformed success", async () => {
		const transport = new FakeTransport({
			status: 200,
			headers: {},
			body: "not-json",
		});
		const client = new CodexImagesClient(transport);
		await assert.rejects(
			client.generate({ prompt: "fox", quality: "auto", size: "auto" }, auth),
			(error: unknown) =>
				error instanceof ExtensionError && error.code === "NO_IMAGE",
		);
		assert.equal(transport.requests.length, 1);
	});
});

test("CodexImagesClient cancels retry sleep immediately", async () => {
	const transport = new FakeTransport(
		jsonResponse(
			429,
			{ error: { code: "rate_limit_exceeded" } },
			{ "retry-after": "60" },
		),
	);
	const controller = new AbortController();
	const client = new CodexImagesClient(transport, {
		sleep: async (_milliseconds, signal) => {
			controller.abort();
			signal?.throwIfAborted();
		},
	});

	await assert.rejects(
		client.generate(
			{ prompt: "fox", quality: "auto", size: "auto" },
			auth,
			controller.signal,
		),
		(error: unknown) =>
			error instanceof ExtensionError && error.code === "CANCELLED",
	);
	assert.equal(transport.requests.length, 1);
});

test("CodexImagesClient maps moderation blocks and empty image data", async (t) => {
	await t.test("moderation", async () => {
		const transport = new FakeTransport(
			jsonResponse(400, {
				error: { code: "moderation_blocked", message: "sensitive detail" },
			}),
		);
		await assert.rejects(
			new CodexImagesClient(transport).generate(
				{ prompt: "fox", quality: "auto", size: "auto" },
				auth,
			),
			(error: unknown) =>
				error instanceof ExtensionError && error.code === "MODERATION_BLOCKED",
		);
	});

	await t.test("missing image", async () => {
		const transport = new FakeTransport(jsonResponse(200, { data: [] }));
		await assert.rejects(
			new CodexImagesClient(transport).generate(
				{ prompt: "fox", quality: "auto", size: "auto" },
				auth,
			),
			(error: unknown) =>
				error instanceof ExtensionError && error.code === "NO_IMAGE",
		);
	});
});
