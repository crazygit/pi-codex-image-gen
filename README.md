# Pi Codex Image Generation

A [Pi package](https://pi.dev/docs/latest/packages) that registers the `codex_generate_image` tool and bundles the `imagegen` skill. It generates or edits one PNG through the current standalone Codex Images endpoints using the ChatGPT Plus/Pro login managed by Pi—no `OPENAI_API_KEY` is required.

## Requirements

- Pi `0.80.6` or compatible
- Node.js 22.19+
- An active ChatGPT Plus/Pro Codex login (`/login` → ChatGPT Plus/Pro)

Both image generation and editing consume Codex subscription image quota.

## Installation

### Git

```bash
pi install git:github.com/crazygit/pi-codex-image-gen
```

Pin a release tag for reproducible installs:

```bash
pi install git:github.com/crazygit/pi-codex-image-gen@v0.2.0
```

### npm

```bash
pi install npm:@crazygit/pi-codex-image-gen
```

To try the package without adding it to settings, replace `pi install` with `pi -e`.

> The npm package and `v0.2.0` tag are not published yet. Until the first release, use the unpinned Git installation or the local development instructions below.

## Usage

Ask Pi naturally, for example:

> Generate a square watercolor fox avatar with a pale blue background.

> Edit `assets/fox.png`: keep the fox unchanged and replace only the background with a sunset.

The bundled `imagegen` skill instructs Pi to call `codex_generate_image` only for explicit generation or editing requests.

Tool parameters:

- `prompt` (required)
- `referencedImagePaths` (optional array of 1–5 local PNG, JPEG, or WebP paths; enables edit/reference mode)
- `outputPath` (optional exact `.png` destination)
- `save`: `auto` (default), `none`, `project`, or `global`
- `size`: `auto`, `1024x1024`, `1536x1024`, or `1024x1536`
- `quality`: `auto`, `low`, `medium`, or `high`

When `referencedImagePaths` is omitted, the tool generates through `/images/generations`. When paths are present, it preserves their order and edits or derives from them through `/images/edits`. Before any local image bytes are read or uploaded, Pi displays the resolved paths and requires interactive confirmation. Headless runs reject local reference uploads.

`save=auto` writes to `<cwd>/.pi/generated-images/<session-id>/` for a trusted project, otherwise to `<agent-dir>/generated-images/<session-id>/`. Existing files are never silently overwritten. Absolute destinations outside the trusted project or Pi agent directory require interactive approval.

The tool returns concise text plus an inline Pi image block. Result `details` contains only small metadata such as model, size, quality, and saved path—never OAuth tokens, auth headers, raw backend responses, or base64 image bytes.

## Safety and protocol behavior

- OAuth is resolved through `ctx.modelRegistry.getApiKeyAndHeaders()`; `auth.json` is never read directly.
- The token is sent only to `https://chatgpt.com/backend-api/codex/images/generations` or `https://chatgpt.com/backend-api/codex/images/edits`; redirects are rejected.
- The request model is fixed to `gpt-image-2`.
- Reference inputs are limited to five regular files. Relative paths require a trusted project; path identity is captured before approval and revalidated through an `O_NOFOLLOW` file handle before reading.
- Input images are decoded locally, normalized only when required for the
  request budget, and held in memory only for the request. Source files are
  limited to 20 MiB each and 50 MiB combined. Headers are checked before
  decoding, with a 16,384-pixel per-axis and 40-megapixel limit.
- Backend response bodies are capped at 36 MiB while streaming. Returned data
  must be canonical base64, no larger than 25 MiB decoded, and have a PNG
  signature before it is saved or previewed.
- Saves revalidate the approved root and directory identity at mutation time, then use Pi's real-target mutation queue, a sibling temporary file, `fsync`, and an atomic no-replace hard-link install.
- Terminal quota errors are not retried. Selected non-terminal responses may retry up to three total attempts. Ambiguous failures are not retried to avoid duplicate quota consumption.
- Escape/abort cancels fetches and retry waits.

Pi packages run with the current user's system permissions. Review third-party package source before installing it.

## Local development

```bash
git clone https://github.com/crazygit/pi-codex-image-gen.git
cd pi-codex-image-gen
npm ci
npm run check
npm test
```

To use an existing local checkout without installing it:

```bash
pi -e /absolute/path/to/pi-codex-image-gen
```

This loads both the extension and bundled skill without modifying Pi settings.
Automated tests inject an in-memory HTTP transport and never contact OpenAI or
consume image quota.

### Migrating from the legacy global extension

If `~/.pi/agent/extensions/codex-image-gen` is still enabled, loading this
package normally would register `codex_generate_image` twice. Keep the old
files in place and isolate the new package for testing:

```bash
pi --no-extensions -e /absolute/path/to/pi-codex-image-gen
```

`--no-extensions` disables automatic extension discovery for that process;
the explicit `-e` package still loads. After validating the package, use
`pi config` to disable the legacy extension before installing or enabling this
package in normal sessions. Disabling it does not delete its files.

To inspect the npm release contents:

```bash
npm pack --dry-run
```

## Current limitations

Edits require explicit local file paths; selecting attached or recent conversation images is not implemented. Masks, batches, API-key fallback, Responses-tool compatibility, alternate image backends, JPEG/WebP output, native transparency controls, and telemetry are not supported.

The ChatGPT Codex Images backend is not a public stable API. This implementation follows the current official Codex standalone Images strategy; future backend changes may require an update.

## License

[MIT](LICENSE)
