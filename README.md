# Pi Codex Image Gen

[![npm version](https://img.shields.io/npm/v/%40crazygit%2Fpi-codex-image-gen)](https://www.npmjs.com/package/@crazygit/pi-codex-image-gen)
[![GitHub release](https://img.shields.io/github/v/release/crazygit/pi-codex-image-gen)](https://github.com/crazygit/pi-codex-image-gen/releases)
[![license](https://img.shields.io/npm/l/%40crazygit%2Fpi-codex-image-gen)](LICENSE)

Generate and edit PNG images in [Pi](https://pi.dev/) through the same
ChatGPT-backed Codex Images flow used by the built-in Codex CLI experience.
Authentication comes from the ChatGPT Plus/Pro Codex login already managed by
Pi. **NO `OPENAI_API_KEY` is required.**

> Image requests follow the same provider-managed service access and usage
> policies as Codex CLI. This project does not define an additional allowance
> or limit, and provider behavior may change independently of this package.

## Highlights

- Generate one PNG from a natural-language prompt.
- Edit or derive from one to five local PNG, JPEG, or WebP images.
- Preview every result inline and save it automatically by default.
- Require interactive approval before local reference images leave the machine.
- Keep OAuth tokens, backend responses, and image bytes out of result metadata.
- Bound input dimensions, request sizes, response sizes, and retries.
- Save atomically without silently overwriting existing files.
- Bundle an `imagegen` skill that activates only for explicit image requests.

## Requirements

- Pi `0.80.6` or a compatible later release
- Node.js 22.19+
- An active ChatGPT Plus/Pro Codex login (`/login` → ChatGPT Plus/Pro)

## Installation

### npm

```bash
pi install npm:@crazygit/pi-codex-image-gen
```

Try a specific version without adding it to settings:

```bash
pi -e npm:@crazygit/pi-codex-image-gen@0.2.2
```

### Git

```bash
pi install git:github.com/crazygit/pi-codex-image-gen@v0.2.2
```

Use the unpinned repository only when you intentionally want the latest commit:

```bash
pi install git:github.com/crazygit/pi-codex-image-gen
```

## Usage

### Start with natural language

In normal use, you do **not** need to call the tool manually or write JSON.
Describe the image you want, and include only the options that matter to you.
The bundled `imagegen` skill maps the request to `codex_generate_image`.

Make a simple request:

> Generate a square watercolor fox avatar with a pale blue background.

Choose the shape, quality, and destination explicitly:

> Generate a high-quality landscape hero image of a mountain observatory at
> night. Use a 1536x1024 canvas and save it to assets/observatory.png.

Edit a local image while preserving explicit invariants:

> Edit assets/fox.png. Keep the fox's pose, colors, and position unchanged;
> replace only the background with a sunset. Save the result to
> assets/fox-sunset.png.

Preview without saving:

> Generate a low-quality square draft of a blue app icon. Preview it without
> saving.

Pi infers the tool arguments from these instructions. If you do not mention a
size or quality, the extension uses provider defaults. Every successful result
is previewed inline and, by default, also saved automatically. Ask to preview
without saving when you do not want a local file.

### Advanced: tool arguments

<details>
<summary>View the structured arguments Pi sends to the extension</summary>

These fields are the internal contract between Pi and the extension. Most users
never need to set them manually.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `prompt` | Required | Final image description or edit instruction. |
| `referencedImagePaths` | Omitted | One to five local PNG, JPEG, or WebP paths; supplying them selects edit mode. |
| `outputPath` | Omitted | Requested `.png` destination; safety checks or name collisions may adjust the final path. |
| `save` | `auto` | Automatic save, preview only, project storage, or Pi agent storage. |
| `size` | `auto` | `1024x1024`, `1536x1024`, or `1024x1536`. |
| `quality` | `auto` | `low`, `medium`, or `high`. |

**Size values**

| Value | Shape | Typical use |
| --- | --- | --- |
| `auto` | Provider-selected | No strict layout requirement. |
| `1024x1024` | Square | Icons, avatars, product tiles, social posts. |
| `1536x1024` | Landscape | Hero images, banners, scenes, presentation art. |
| `1024x1536` | Portrait | Posters, covers, character art, mobile layouts. |

**Save values**

| Value | Behavior |
| --- | --- |
| `auto` | Use the trusted project when available; otherwise use the Pi agent directory. |
| `project` | Save under `<cwd>/.pi/generated-images/<session-id>/`; requires a trusted project. |
| `global` | Save under `<agent-dir>/generated-images/<session-id>/`. |
| `none` | Return the inline preview without writing a file. |

`outputPath` takes precedence over the automatic `project` or `global` location
and cannot be combined with `save: "none"`. Relative paths require a trusted
project and must stay inside it. An absolute path outside the trusted project or
Pi agent directory requires interactive approval and therefore fails in
headless mode. Existing files are never silently overwritten; a collision
receives a numeric suffix, which is reflected in the returned `savedPath`.

</details>

### Reference-image approval

Supplying `referencedImagePaths` switches from generation to editing. Before
reading or uploading local bytes, Pi displays the resolved paths and asks for
interactive confirmation. Headless runs reject reference uploads, and relative
paths require a trusted project.

Direct selection of attached or recent conversation images is not implemented;
provide a local path instead.

### Result

Every successful call returns an inline Pi image block. Saving is enabled by
default, so the result normally also includes the final `savedPath`. A request
to preview without saving returns only the inline image. Result metadata
includes small fields such as model, size, quality, and saved path.

## How it works

- Pi resolves the existing Codex login through
  `ctx.modelRegistry.getApiKeyAndHeaders()`; the package never reads
  `auth.json` directly.
- Requests are restricted to the current Codex Images generation and edit
  endpoints on `chatgpt.com`; redirects and unexpected destinations are
  rejected.
- The request model is fixed to `gpt-image-2`.
- Selected transient gateway failures are retried once with bounded backoff;
  ambiguous transport failures and malformed success responses are not retried.
- The flow mirrors the current built-in Codex CLI image path rather than the
  public API-key Images product.

The ChatGPT-backed Codex Images endpoints are not a public stable API. Provider
changes may require a package update.

## Limitations

The current release creates one PNG at a time. It does not support masks,
batches, direct conversation-image selection, API-key fallback,
Responses-tool compatibility, alternate image backends, JPEG/WebP output,
native transparency controls, or telemetry.

## Development

```bash
git clone https://github.com/crazygit/pi-codex-image-gen.git
cd pi-codex-image-gen
npm ci
npm run check
npm test
npm pack --dry-run
```

Load a local checkout without changing Pi settings:

```bash
pi -e /absolute/path/to/pi-codex-image-gen
```

Automated tests use in-memory transports and do not contact OpenAI or make real
image requests.

## Contributing

Issues and focused pull requests are welcome. Before opening a pull request:

1. Keep changes scoped to this package.
2. Add or update tests for behavior changes.
3. Run `npm run check` and `npm test`.
4. Inspect release contents with `npm pack --dry-run`.

Report bugs and compatibility changes through
[GitHub Issues](https://github.com/crazygit/pi-codex-image-gen/issues).

## License

[MIT](LICENSE)
