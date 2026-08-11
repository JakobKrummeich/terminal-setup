#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$REPO/pi/patches/pi-azure-response-failed-retry.cjs"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

run_patch() {
  local version="$1"
  local root="$FIXTURE/$version"
  mkdir -p "$root/dist/utils"
  printf '{"version":"%s","type":"module"}\n' "$version" > "$root/package.json"
  cp "$REPO/test/fixtures/pi-ai-0.83.0-retry.js" "$root/dist/utils/retry.js"
  PI_AI_ROOT="$root" node "$PATCH" >&2
  PI_AI_ROOT="$root" node "$PATCH" >&2
  printf '%s\n' "$root/dist/utils/retry.js"
}

RETRY_083="$(run_patch 0.83.0)"
RETRY_084="$(run_patch 0.84.1)"
node --input-type=module - "$RETRY_083" "$RETRY_084" <<'NODE'
import assert from "node:assert/strict";
for (const retryPath of process.argv.slice(2)) {
  const { isRetryableAssistantError } = await import(`file://${retryPath}`);
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
}
console.log("PASS: scoped Azure hidden-response retry patch for 0.83.0 and 0.84.1");
NODE
