# Pi test fixtures

Unmodified `dist/utils/retry.js` from `@earendil-works/pi-ai`:

- `pi-ai-0.87.1-retry.js` — SHA-256 `292e2a6654fdd48d6f020eedb2084a70b3ccceb289c37c65ad2d41c45dc664dc`
- `pi-ai-0.99.0-retry.js` — SHA-256 `ae91b950515c239d8bbae9e6a85074b10d5ae4195b20effa228ea51898c0658d`
- `pi-ai-0.99.1-retry.js` — same file as 0.99.0 (same SHA-256)

Excerpts of the `pi` CLI bundle of `@earendil-works/pi-coding-agent` (the full
chunks are several MB): `buildProviderErrorPattern`, the two provider-error
pattern declarations and `isRetryableAssistantError`, each copied verbatim,
plus a comment line and an `export` so the tests can import the classifier:

- `pi-coding-agent-0.87.1-bundle-retry.js` — from `dist/bundle/chunks/chunk-OJP47DM6.js`
  (full chunk SHA-256 `81c81a21ec81e84200205f561687408ff5e3738fbbbb3c2a6c186b348d376020`)
- `pi-coding-agent-0.99.0-bundle-retry.js` — from `dist/bundle/chunks/chunk-4CSSZFEW.js`
  (full chunk SHA-256 `dba68f1ea740414a4bc4a1d7806bc418baf6e7fe67e54582ca5325ae21025862`)
- `pi-coding-agent-0.99.1-bundle-retry.js` — from `dist/bundle/chunks/chunk-GUORCHFS.js`
  (full chunk SHA-256 `b858ce2c4ddbfa1594142e39d7b6ebce328010e116c08db9663602cd26171425`;
  excerpt identical to 0.99.0's apart from the comment line)

Source: <https://github.com/earendil-works/pi>, `packages/ai` and `packages/coding-agent`.
License: MIT. Copyright Mario Zechner and contributors.
