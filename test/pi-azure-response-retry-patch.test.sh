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

make_unhashed() { # <version> → pi-ai root with an unhashed version
  local root="$FIXTURE/unhashed-$1"
  mkdir -p "$root/dist/utils"
  printf '{"version":"%s","type":"module"}\n' "$1" > "$root/package.json"
  cp "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$root/dist/utils/retry.js"
  printf '%s\n' "$root"
}

# Older than every hashed version (pre-0.87 Pi): skip cleanly (exit 0, one line,
# no stack trace) and leave retry.js untouched.
for version in 0.86.1 0.87.0; do
  old="$(make_unhashed "$version")"
  if ! out="$(PI_AI_ROOT="$old" node "$PATCH" 2>&1)"; then
    echo "FAIL: pi-ai $version must skip, not fail: $out" >&2
    exit 1
  fi
  [ "$out" = "SKIPPED: Pi Azure retry patch (pi-ai $version predates the patched 0.87.1; retry.js untouched)." ] || {
    echo "FAIL: pi-ai $version skip message: $out" >&2
    exit 1
  }
  cmp -s "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$old/dist/utils/retry.js"
done

# Newer unhashed versions still fail closed (patch must be reviewed after a Pi upgrade).
for version in 0.87.2 0.88.0 not-a-version; do
  new="$(make_unhashed "$version")"
  if PI_AI_ROOT="$new" node "$PATCH" 2>/dev/null; then
    echo "FAIL: patch accepted unhashed pi-ai $version" >&2
    exit 1
  fi
  cmp -s "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$new/dist/utils/retry.js"
done

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
