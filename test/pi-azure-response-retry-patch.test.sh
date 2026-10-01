#!/usr/bin/env bash
# pi/patches/pi-azure-response-failed-retry.cjs against fixture Pi trees:
# pi-ai's real dist/utils/retry.js (0.87.1, 0.99.0, 0.99.1, 0.99.2) plus a CLI bundle whose one
# retry chunk is a verbatim excerpt of the real chunk (test/fixtures/README.md).
# The real chunks are MBs, so the bundle's pinned sha256s are swapped for the
# excerpt's via main()'s hash-table argument; the retry.js hashes stay the
# production ones. The production table's bundle pins are checked by hand
# against the npm packages (README.md "Pi Azure retry patch").
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$REPO/pi/patches/pi-azure-response-failed-retry.cjs"
FIXTURES="$REPO/test/fixtures"
FIXTURE="$(mktemp -d)"
trap 'chmod -R u+w "$FIXTURE"; rm -rf "$FIXTURE"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

make_pi() { # <dir> <version> <fixture-version>: pi-ai + pi-coding-agent roots
  local dir="$1" version="$2" fixture="$3"
  mkdir -p "$dir/pi-ai/dist/utils" "$dir/agent/dist/bundle/chunks"
  printf '{"version":"%s","type":"module"}\n' "$version" > "$dir/pi-ai/package.json"
  cp "$FIXTURES/pi-ai-$fixture-retry.js" "$dir/pi-ai/dist/utils/retry.js"
  printf '{"name":"@earendil-works/pi-coding-agent","version":"%s","type":"module"}\n' "$version" \
    > "$dir/agent/package.json"
  printf '#!/usr/bin/env node\nimport "./chunks/chunk-DECOY.js";\n' > "$dir/agent/dist/bundle/cli.js"
  printf 'export const unrelated = 1;\n' > "$dir/agent/dist/bundle/chunks/chunk-DECOY.js"
  cp "$FIXTURES/pi-coding-agent-$fixture-bundle-retry.js" "$dir/agent/dist/bundle/chunks/chunk-RETRY.js"
}

# main() with the production table, bundle pins swapped for the excerpt's.
cat > "$FIXTURE/drive.cjs" <<'NODE'
const fs = require("node:fs");
const [patchPath, fixtures, piAiRoot, agentRoot] = process.argv.slice(2);
const { EXPECTED_HASHES, TARGETS, main, sha256 } = require(patchPath);
const bundle = TARGETS.find((target) => target.key === "bundle");
const table = new Map([...EXPECTED_HASHES].map(([version, hashes]) => {
  const excerpt = fs.readFileSync(`${fixtures}/pi-coding-agent-${version}-bundle-retry.js`, "utf8");
  return [version, { ...hashes, bundle: { baseline: sha256(excerpt), patched: sha256(bundle.transform(excerpt)) } }];
}));
try {
  main({ PI_AI_ROOT: piAiRoot, PI_CODING_AGENT_ROOT: agentRoot }, table);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(error.exitCode ?? 1);
}
NODE
drive() { node "$FIXTURE/drive.cjs" "$PATCH" "$FIXTURES" "$1/pi-ai" "$1/agent"; }

snapshot() { find "$1" -type f -print0 | sort -z | xargs -0 sha256sum; }

# The production pins match the committed pristine retry.js fixtures, and the
# retry transform reproduces the pinned patched hash (no table injection).
node - "$PATCH" "$FIXTURES" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [patchPath, fixtures] = process.argv.slice(2);
const { EXPECTED_HASHES, TARGETS, sha256 } = require(patchPath);
assert.deepEqual([...EXPECTED_HASHES.keys()], ["0.87.1", "0.99.0", "0.99.1", "0.99.2"]);
const retry = TARGETS.find((target) => target.key === "retry");
for (const [version, hashes] of EXPECTED_HASHES) {
  const source = fs.readFileSync(`${fixtures}/pi-ai-${version}-retry.js`, "utf8");
  assert.equal(sha256(source), hashes.retry.baseline, `${version} retry.js baseline`);
  assert.equal(sha256(retry.transform(source)), hashes.retry.patched, `${version} retry.js patched`);
  assert.match(hashes.bundle.baseline, /^[0-9a-f]{64}$/);
  assert.match(hashes.bundle.patched, /^[0-9a-f]{64}$/);
}
NODE

for version in 0.87.1 0.99.0 0.99.1 0.99.2; do
  root="$FIXTURE/pi-$version"
  make_pi "$root" "$version" "$version"
  out="$(drive "$root")" || fail "$version first run: $out"
  [ "$(grep -c '^Applied Pi Azure hidden-response retry patch: ' <<<"$out")" = 2 ] || fail "$version first run: $out"
  [[ "$out" == *"pi CLI bundle ($root/agent/dist/bundle/chunks/chunk-RETRY.js)"* ]] || fail "$version chunk: $out"
  before="$(snapshot "$root")"
  out="$(drive "$root")" || fail "$version re-run: $out"
  [ "$(grep -c '^Pi Azure hidden-response retry patch already applied: ' <<<"$out")" = 2 ] || fail "$version re-run: $out"
  [ "$before" = "$(snapshot "$root")" ] || fail "$version re-run modified files"
  cmp -s "$FIXTURES/pi-ai-$version-retry.js" "$root/pi-ai/dist/utils/retry.js.pre-terminal-setup-backup" \
    || fail "$version retry.js backup"
  cmp -s "$FIXTURES/pi-coding-agent-$version-bundle-retry.js" \
    "$root/agent/dist/bundle/chunks/chunk-RETRY.js.pre-terminal-setup-backup" || fail "$version bundle backup"
  printf 'export const unrelated = 1;\n' | cmp -s - "$root/agent/dist/bundle/chunks/chunk-DECOY.js" \
    || fail "$version decoy chunk modified"
done

# Both patched classifiers (SDK retry.js, CLI bundle excerpt) of both versions:
# only Azure's hidden response.failed error becomes retryable.
node --input-type=module - "$FIXTURE"/pi-*/pi-ai/dist/utils/retry.js \
  "$FIXTURE"/pi-*/agent/dist/bundle/chunks/chunk-RETRY.js <<'NODE'
import assert from "node:assert/strict";
for (const file of process.argv.slice(2)) {
  const { isRetryableAssistantError } = await import(`file://${file}`);
  const unknownAzureFailure = {
    stopReason: "error",
    provider: "azure-openai-responses",
    rawStopReason: "failed",
    errorMessage: "Unknown error (no error details in response)",
  };
  assert.equal(isRetryableAssistantError(unknownAzureFailure), true, file);
  assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, provider: "openai" }), false, file);
  assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, rawStopReason: "completed" }), false, file);
  assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, errorMessage: "insufficient_quota" }), false, file);
  assert.equal(isRetryableAssistantError({ ...unknownAzureFailure, errorMessage: "429 Too Many Requests" }), true, file);
}
NODE

# Half-applied install (retry.js patched by an older version of this script,
# bundle still pristine): only the bundle is written.
half="$FIXTURE/half"
make_pi "$half" 0.87.1 0.87.1
cp "$FIXTURE/pi-0.87.1/pi-ai/dist/utils/retry.js" "$half/pi-ai/dist/utils/retry.js"
out="$(drive "$half")" || fail "half-applied: $out"
[[ "$out" == *"already applied: pi-ai dist/utils/retry.js (SDK)."*"Applied Pi Azure hidden-response retry patch: pi CLI bundle"* ]] \
  || fail "half-applied: $out"
[ ! -e "$half/pi-ai/dist/utils/retry.js.pre-terminal-setup-backup" ] || fail "half-applied: retry.js rewritten"

expect_failure() { # <label> <root> <expected-error-substring>: fails, and writes nothing
  local before out
  before="$(snapshot "$2")"
  if out="$(drive "$2" 2>&1)"; then fail "$1: patch unexpectedly succeeded: $out"; fi
  [[ "$out" == *"$3"* ]] || fail "$1: expected '$3' in: $out"
  [ "$before" = "$(snapshot "$2")" ] || fail "$1: files modified despite the failure"
}

# Fail closed, all-or-nothing: retry.js stays pristine when the bundle is off.
ambiguous="$FIXTURE/ambiguous"
make_pi "$ambiguous" 0.99.0 0.99.0
cp "$ambiguous/agent/dist/bundle/chunks/chunk-RETRY.js" "$ambiguous/agent/dist/bundle/chunk-COPY.js"
expect_failure "two classifier chunks" "$ambiguous" "Expected exactly one retry classifier"
rm "$ambiguous/agent/dist/bundle/chunk-COPY.js" "$ambiguous/agent/dist/bundle/chunks/chunk-RETRY.js"
expect_failure "no classifier chunk" "$ambiguous" "found 0"
tampered="$FIXTURE/tampered"
make_pi "$tampered" 0.99.0 0.99.0
printf '// local edit\n' >> "$tampered/agent/dist/bundle/chunks/chunk-RETRY.js"
expect_failure "tampered bundle" "$tampered" "Unexpected pi CLI bundle"
swapped="$FIXTURE/swapped"
make_pi "$swapped" 0.99.0 0.87.1
expect_failure "0.87.1 files labelled 0.99.0" "$swapped" "Unexpected pi-ai dist/utils/retry.js (SDK)"

# Production CLI: older than every pinned version (pre-0.87.1 Pi) skips cleanly
# (exit 0, no stack trace) and touches nothing; newer unknown ones fail closed.
for version in 0.86.1 0.87.0; do
  old="$FIXTURE/old-$version"
  make_pi "$old" "$version" 0.87.1
  before="$(snapshot "$old")"
  out="$(PI_AI_ROOT="$old/pi-ai" PI_CODING_AGENT_ROOT="$old/agent" node "$PATCH" 2>&1)" \
    || fail "pi $version must skip, not fail: $out"
  [ "$out" = "SKIPPED: Pi Azure retry patch for pi-ai dist/utils/retry.js (SDK) (pi-ai $version predates the patched 0.87.1, 0.99.0, 0.99.1, 0.99.2; untouched).
SKIPPED: Pi Azure retry patch for pi CLI bundle (pi-coding-agent $version predates the patched 0.87.1, 0.99.0, 0.99.1, 0.99.2; untouched)." ] \
    || fail "pi $version skip message: $out"
  [ "$before" = "$(snapshot "$old")" ] || fail "pi $version: files modified"
done
for version in 0.87.2 0.99.3 1.0.0 not-a-version; do
  new="$FIXTURE/new-$version"
  make_pi "$new" "$version" 0.99.0
  before="$(snapshot "$new")"
  if out="$(PI_AI_ROOT="$new/pi-ai" PI_CODING_AGENT_ROOT="$new/agent" node "$PATCH" 2>&1)"; then
    fail "patch accepted unpinned pi $version: $out"
  fi
  [ "$out" = "ERROR: Expected pi-ai one of 0.87.1, 0.99.0, 0.99.1, 0.99.2, found $version; patch not applied." ] \
    || fail "pi $version error: $out"
  [ "$before" = "$(snapshot "$new")" ] || fail "pi $version: files modified"
done
if out="$(PI_AI_ROOT="$FIXTURE/pi-0.99.0/pi-ai" node "$PATCH" 2>&1)"; then fail "ran without PI_CODING_AGENT_ROOT"; fi
[ "$out" = "ERROR: PI_CODING_AGENT_ROOT is required; run install-pi.sh." ] || fail "missing root: $out"

# Root-owned install run as a normal user (simulated with chmod; root ignores it).
if [ "$(id -u)" -eq 0 ]; then
  echo "SKIP: unwritable-install cases (running as root, chmod does not block writes)"
else
  expect_not_writable() { # <label> <root> <expected-path>: exit 3, names the path, writes nothing
    local before out rc=0
    before="$(snapshot "$2")"
    out="$(drive "$2" 2>&1)" || rc=$?
    [ "$rc" = 3 ] || fail "$1: expected exit 3, got $rc: $out"
    [[ "$out" == *"$3"*"not writable by this user"*"no file was changed"* ]] || fail "$1: message: $out"
    [ "$before" = "$(snapshot "$2")" ] || fail "$1: files modified"
  }
  locked="$FIXTURE/locked"
  make_pi "$locked" 0.99.1 0.99.1
  chmod a-w "$locked/agent/dist/bundle/chunks/chunk-RETRY.js" "$locked/agent/dist/bundle/chunks"
  # retry.js is writable, but all-or-nothing: it must stay pristine too.
  expect_not_writable "bundle unwritable" "$locked" "$locked/agent/dist/bundle/chunks/chunk-RETRY.js"
  chmod a-w "$locked/pi-ai/dist/utils/retry.js" "$locked/pi-ai/dist/utils"
  expect_not_writable "both unwritable" "$locked" "$locked/pi-ai/dist/utils/retry.js"
  # A stale backup that cannot be overwritten blocks too, even with a writable dir.
  stale="$FIXTURE/stale-backup"
  make_pi "$stale" 0.99.1 0.99.1
  touch "$stale/pi-ai/dist/utils/retry.js.pre-terminal-setup-backup"
  chmod a-w "$stale/pi-ai/dist/utils/retry.js.pre-terminal-setup-backup"
  expect_not_writable "read-only backup" "$stale" "$stale/pi-ai/dist/utils/retry.js.pre-terminal-setup-backup"
  # Already applied needs no write access: read-only still succeeds.
  applied="$FIXTURE/pi-0.99.1"
  chmod -R a-w "$applied"
  before="$(snapshot "$applied")"
  out="$(drive "$applied" 2>&1)" || fail "read-only already-applied: $out"
  [ "$(grep -c '^Pi Azure hidden-response retry patch already applied: ' <<<"$out")" = 2 ] \
    || fail "read-only already-applied: $out"
  [ "$before" = "$(snapshot "$applied")" ] || fail "read-only already-applied: files modified"
  # Production CLI maps it to exit 3 too (bundle skipped via a pre-0.87.1 agent version).
  cli="$FIXTURE/cli-locked"
  make_pi "$cli" 0.99.1 0.99.1
  printf '{"name":"@earendil-works/pi-coding-agent","version":"0.86.1"}\n' > "$cli/agent/package.json"
  chmod a-w "$cli/pi-ai/dist/utils"
  rc=0
  out="$(PI_AI_ROOT="$cli/pi-ai" PI_CODING_AGENT_ROOT="$cli/agent" node "$PATCH" 2>&1)" || rc=$?
  [ "$rc" = 3 ] || fail "production CLI unwritable: expected exit 3, got $rc: $out"
  cmp -s "$FIXTURES/pi-ai-0.99.1-retry.js" "$cli/pi-ai/dist/utils/retry.js" || fail "production CLI: retry.js modified"
fi

echo "PASS: Azure hidden-response retry patch (SDK retry.js + CLI bundle) for 0.87.1, 0.99.0, 0.99.1 and 0.99.2"
