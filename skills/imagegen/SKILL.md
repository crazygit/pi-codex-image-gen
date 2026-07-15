---
name: imagegen
description: Generate or edit a raster image with codex_generate_image using ChatGPT Plus/Pro Codex subscription quota. Use when the user clearly asks to create a new image or modify/derive from one to five local raster images.
---

# Codex image generation and editing

Use `codex_generate_image` for an explicit request to create one new raster image or edit/derive from existing local images. Tell the user that either operation consumes Codex subscription image quota when that is not already clear.

- Write a concise, concrete prompt describing purpose, subject, composition, style, lighting, colors, and hard constraints.
- For edits, repeat invariants explicitly: identify what may change and what must remain unchanged.
- Pass `referencedImagePaths` only for 1–5 local PNG, JPEG, or WebP files the user explicitly wants uploaded to Codex. Preserve their intended order and describe each image's role in the prompt.
- Local reference uploads require interactive approval. If the user only attached an image without a usable local path, explain that direct conversation-image selection is not supported yet and ask for its path.
- Pass `outputPath` only when the user asks for a specific destination.
- Otherwise leave `save` as `auto`: trusted projects save under `.pi/generated-images/`; untrusted projects save under the global Pi agent directory.
- Use `save: "none"` only when the user asks to preview without saving.
- Do not invoke this tool for image analysis, SVG or other code-native graphics, or without clear generation/editing intent.
- The current version creates one PNG. It does not support masks, batch generation, native transparency controls, or JPEG/WebP output.
