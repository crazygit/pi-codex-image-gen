import type { CodexAuth } from "../auth/codex-auth.ts";
import { ExtensionError, cancelledError } from "../errors.ts";
import { abortableSleep, retryDelayMs, type Sleep } from "../runtime/retry.ts";
import type {
	GeneratedImageData,
	HttpRequest,
	HttpResponse,
	HttpTransport,
	ImageQuality,
	ImageSize,
} from "../types.ts";

const CODEX_GENERATIONS_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/images/generations";
const CODEX_EDITS_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/images/edits";
const MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BODY_BYTES = 36 * 1024 * 1024;
const TERMINAL_LIMIT_CODES =
	/usage[_ ]limit[_ ]reached|usage[_ ]not[_ ]included|insufficient[_ ]quota|monthly[_ ]limit|billing[_ ]hard[_ ]limit/i;
const MODERATION_CODES = /moderation|content_policy|safety/i;
const EXPLICIT_TRANSIENT_CODES = new Set([
	"server_overloaded",
	"temporarily_unavailable",
	"service_unavailable",
]);

export interface CodexGenerateRequest {
	prompt: string;
	quality: ImageQuality;
	size: ImageSize;
}

export interface CodexEditRequest extends CodexGenerateRequest {
	images: readonly string[];
}

interface CodexImagesClientOptions {
	sleep?: Sleep;
}

interface ErrorPayload {
	code?: string | undefined;
	type?: string | undefined;
	message?: string | undefined;
}

export class FetchHttpTransport implements HttpTransport {
	async send(
		request: HttpRequest,
		signal?: AbortSignal,
	): Promise<HttpResponse> {
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			body: request.body,
			redirect: "error",
		};
		if (signal !== undefined) init.signal = signal;
		const response = await fetchCodexEndpoint(request.url, init);
		const contentLength = response.headers.get("content-length");
		if (
			contentLength !== null &&
			/^\d+$/.test(contentLength) &&
			Number(contentLength) > MAX_RESPONSE_BODY_BYTES
		) {
			if (response.body !== null) {
				await response.body.cancel().catch(() => undefined);
			}
			throw new Error(
				"The Codex image service response exceeded the safe size limit.",
			);
		}
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return {
			status: response.status,
			headers,
			body: await readBoundedResponseBody(response),
		};
	}
}

async function readBoundedResponseBody(response: Response): Promise<string> {
	if (response.body === null) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
				await reader.cancel();
				throw new Error(
					"The Codex image service response exceeded the safe size limit.",
				);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}

async function fetchCodexEndpoint(
	url: string,
	init: RequestInit,
): Promise<Response> {
	switch (url) {
		case CODEX_GENERATIONS_ENDPOINT:
			return fetch(CODEX_GENERATIONS_ENDPOINT, init);
		case CODEX_EDITS_ENDPOINT:
			return fetch(CODEX_EDITS_ENDPOINT, init);
		default:
			throw new Error("Unexpected Codex image service endpoint.");
	}
}

export class CodexImagesClient {
	private readonly transport: HttpTransport;
	private readonly sleep: Sleep;

	constructor(
		transport: HttpTransport,
		options: CodexImagesClientOptions = {},
	) {
		this.transport = transport;
		this.sleep = options.sleep ?? abortableSleep;
	}

	async generate(
		request: CodexGenerateRequest,
		auth: CodexAuth,
		signal?: AbortSignal,
	): Promise<GeneratedImageData> {
		return this.sendImageRequest(
			CODEX_GENERATIONS_ENDPOINT,
			{
				model: "gpt-image-2",
				prompt: request.prompt,
				background: "auto",
				quality: request.quality,
				size: request.size,
			},
			auth,
			signal,
		);
	}

	async edit(
		request: CodexEditRequest,
		auth: CodexAuth,
		signal?: AbortSignal,
	): Promise<GeneratedImageData> {
		return this.sendImageRequest(
			CODEX_EDITS_ENDPOINT,
			{
				model: "gpt-image-2",
				images: request.images.map((imageUrl) => ({ image_url: imageUrl })),
				prompt: request.prompt,
				background: "auto",
				quality: request.quality,
				size: request.size,
			},
			auth,
			signal,
		);
	}

	private async sendImageRequest(
		endpoint: string,
		body: Record<string, unknown>,
		auth: CodexAuth,
		signal?: AbortSignal,
	): Promise<GeneratedImageData> {
		const httpRequest: HttpRequest = {
			method: "POST",
			url: endpoint,
			headers: { ...auth.headers },
			body: JSON.stringify(body),
		};

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			if (signal?.aborted) throw cancelledError();

			let response: HttpResponse;
			try {
				response = await this.transport.send(httpRequest, signal);
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw cancelledError();
				throw new ExtensionError(
					"BACKEND_UNAVAILABLE",
					"The Codex image service could not be reached. The request was not retried to avoid a duplicate image request.",
				);
			}

			if (response.status >= 200 && response.status < 300) {
				return parseSuccessfulResponse(response.body);
			}

			const backendError = parseErrorPayload(response.body);
			const code = backendError.code ?? backendError.type ?? "";
			const limitSignal = `${code} ${backendError.message ?? ""}`;
			if (TERMINAL_LIMIT_CODES.test(limitSignal)) {
				throw new ExtensionError(
					"USAGE_LIMIT",
					"The Codex service reported that this account's current usage limit has been reached. Check Codex availability for the account and try again later.",
				);
			}
			if (MODERATION_CODES.test(code)) {
				throw new ExtensionError(
					"MODERATION_BLOCKED",
					"The image request was blocked by the provider's safety checks. Revise the prompt and try again.",
				);
			}

			const retryableRateLimit = response.status === 429;
			const retryableUnavailable =
				[502, 503, 504].includes(response.status) &&
				EXPLICIT_TRANSIENT_CODES.has(code.toLowerCase());
			if (
				(retryableRateLimit || retryableUnavailable) &&
				attempt < MAX_ATTEMPTS
			) {
				const delay = retryDelayMs(response.headers, attempt);
				try {
					await this.sleep(delay, signal);
				} catch (error) {
					if (signal?.aborted || isAbortError(error) || isCancelled(error))
						throw cancelledError();
					throw error;
				}
				continue;
			}

			if (response.status === 429) {
				throw new ExtensionError(
					"RATE_LIMITED",
					"The Codex image service is temporarily rate limited. Try again later.",
					{ retryAfterMs: retryDelayMs(response.headers, attempt) },
				);
			}
			if (response.status >= 500) {
				throw new ExtensionError(
					"BACKEND_UNAVAILABLE",
					"The Codex image service is temporarily unavailable. Ambiguous failures are not retried to avoid a duplicate image request.",
				);
			}
			throw new ExtensionError(
				"INVALID_REQUEST",
				"The Codex image service rejected the request. Check the prompt and generation options.",
			);
		}

		throw new ExtensionError(
			"BACKEND_UNAVAILABLE",
			"The Codex image service is temporarily unavailable.",
		);
	}
}

function parseSuccessfulResponse(body: string): GeneratedImageData {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new ExtensionError(
			"NO_IMAGE",
			"The Codex image service returned an unreadable response. The request was not retried to avoid a duplicate image request.",
		);
	}

	if (!payload || typeof payload !== "object") throw noImageError();
	const record = payload as Record<string, unknown>;
	const data = record.data;
	if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object")
		throw noImageError();
	const base64 = (data[0] as Record<string, unknown>).b64_json;
	if (typeof base64 !== "string" || base64.length === 0) throw noImageError();

	const result: GeneratedImageData = { base64 };
	if (typeof record.created === "number") result.created = record.created;
	if (typeof record.quality === "string") result.quality = record.quality;
	if (typeof record.size === "string") result.size = record.size;
	return result;
}

function noImageError(): ExtensionError {
	return new ExtensionError(
		"NO_IMAGE",
		"The Codex image service returned no image data.",
	);
}

function parseErrorPayload(body: string): ErrorPayload {
	try {
		const payload = JSON.parse(body) as Record<string, unknown>;
		const rawError = payload.error;
		const error =
			rawError && typeof rawError === "object"
				? (rawError as Record<string, unknown>)
				: payload;
		return {
			code: typeof error.code === "string" ? error.code : undefined,
			type: typeof error.type === "string" ? error.type : undefined,
			message: typeof error.message === "string" ? error.message : undefined,
		};
	} catch {
		return {};
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isCancelled(error: unknown): boolean {
	return error instanceof ExtensionError && error.code === "CANCELLED";
}
