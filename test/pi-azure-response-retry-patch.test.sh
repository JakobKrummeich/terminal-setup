#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$REPO/pi/patches/pi-0.83.0-azure-response-failed-retry.cjs"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/dist/utils"
printf '{"version":"0.83.0","type":"module"}\n' > "$FIXTURE/package.json"
cp /home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js.pi-0.83.0-backup "$FIXTURE/dist/utils/retry.js"

PI_AI_ROOT="$FIXTURE" node "$PATCH"
PI_AI_ROOT="$FIXTURE" node "$PATCH"
node --input-type=module - "$FIXTURE/dist/utils/retry.js" <<'NODE'
import assert from "node:assert/strict";
const { isRetryableAssistantError } = await import(`file://${process.argv[2]}`);
const unknownAzureFailure = {
  stopReason: "error",
  provider: "azure-openai-responses",
  rawStopReason: "failed",
  errorMessage: "Unknown error (no error details in response)",
};
assert.equal(isRetryableAssistantError(unknownAzureFailure), true);
assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, provider: "openai" }), false);
assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, rawStopReason: "completed" }), false);
assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, errorMessage: "insufficient_quota" }), false);
console.log("PASS: scoped Azure hidden-response retry patch");
NODE
