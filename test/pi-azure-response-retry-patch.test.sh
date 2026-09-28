#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$REPO/pi/patches/pi-azure-response-failed-retry.cjs"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

run_patch() {
  local version="$1"
  local fixture="$2"
  local root="$FIXTURE/$version"
  mkdir -p "$root/dist/utils"
  printf '{"version":"%s","type":"module"}\n' "$version" > "$root/package.json"
  cp "$REPO/test/fixtures/$fixture" "$root/dist/utils/retry.js"
  PI_AI_ROOT="$root" node "$PATCH" >&2
  PI_AI_ROOT="$root" node "$PATCH" >&2
  printf '%s\n' "$root/dist/utils/retry.js"
}

RETRY_0871="$(run_patch 0.87.1 pi-ai-0.87.1-retry.js)"

# Versions without a hash entry (e.g. pre-0.87 Pi) must fail closed and leave retry.js untouched.
unsupported="$FIXTURE/unsupported"
mkdir -p "$unsupported/dist/utils"
printf '{"version":"0.86.1","type":"module"}\n' > "$unsupported/package.json"
cp "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$unsupported/dist/utils/retry.js"
if PI_AI_ROOT="$unsupported" node "$PATCH" 2>/dev/null; then
  echo "FAIL: patch accepted unsupported pi-ai 0.86.1" >&2
  exit 1
fi
cmp -s "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$unsupported/dist/utils/retry.js"

node --input-type=module - "$RETRY_0871" <<'NODE'
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
console.log("PASS: scoped Azure hidden-response retry patch for 0.87.1");
NODE
