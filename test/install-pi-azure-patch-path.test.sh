#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
REAL_NODE="$(command -v node)"
trap 'chmod -R u+w "$FIXTURE"; rm -rf "$FIXTURE"' EXIT

make_node_stub() { # <bin-dir>
    mkdir -p "$1"
    cat > "$1/node" <<'NODE'
#!/usr/bin/env bash
if [ -n "${PI_AI_ROOT-}" ]; then
  printf '%s\n%s\n' "$PI_AI_ROOT" "${PI_CODING_AGENT_ROOT-}" > "$NODE_ENV_CAPTURE"
  exit 0
fi
exec "$REAL_NODE" "$@"
NODE
    chmod +x "$1/node"
}

run_installer() { # <bin-dir> <capture-file>
    NODE_ENV_CAPTURE="$2" REAL_NODE="$REAL_NODE" PATH="$1:$PATH" REPO="$REPO" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      install_pi_azure_response_retry_patch
    '
}

# Legacy/npm layout: pi resolves directly into the package tree.
legacy="$FIXTURE/legacy"
mkdir -p "$legacy/pi-root/dist" "$legacy/pi-root/node_modules/@earendil-works/pi-ai" "$legacy/bin"
printf '#!/usr/bin/env bash\n' > "$legacy/pi-root/dist/cli.js"
chmod +x "$legacy/pi-root/dist/cli.js"
printf '{"name":"@earendil-works/pi-coding-agent"}\n' > "$legacy/pi-root/package.json"
printf '{"version":"fixture"}\n' > "$legacy/pi-root/node_modules/@earendil-works/pi-ai/package.json"
ln -s "$legacy/pi-root/dist/cli.js" "$legacy/bin/pi"
make_node_stub "$legacy/bin"
run_installer "$legacy/bin" "$legacy/captured"
expected="$(readlink -f "$legacy/pi-root/node_modules/@earendil-works/pi-ai")
$(readlink -f "$legacy/pi-root")"
actual="$(cat "$legacy/captured")"
[ "$actual" = "$expected" ] || {
    echo "legacy: expected PI_AI_ROOT + PI_CODING_AGENT_ROOT=$expected, got $actual" >&2
    exit 1
}

# The CLI bundle lives in pi-coding-agent: no such package above the executable fails closed.
rm "$legacy/pi-root/package.json"
if run_installer "$legacy/bin" "$legacy/no-agent-captured" > "$legacy/no-agent-error" 2>&1; then
    echo "legacy: missing pi-coding-agent package unexpectedly succeeded" >&2
    exit 1
fi
grep -F "Pi coding-agent package not found from Pi executable" "$legacy/no-agent-error" >/dev/null

# Managed layout: regular launcher selects one release; stale releases must be ignored.
managed="$FIXTURE/custom-agent"
active="$managed/install/releases/0.87.1"
stale="$managed/install/releases/0.86.1"
mkdir -p "$managed/bin" "$managed/node_modules/@earendil-works/pi-ai" \
    "$active/node_modules/.bin" \
    "$active/node_modules/@earendil-works/pi-coding-agent/dist" \
    "$active/node_modules/@earendil-works/pi-ai" \
    "$stale/node_modules/@earendil-works/pi-ai"
make_node_stub "$managed/bin"
printf '#!/bin/sh\nexit 0\n' > "$managed/bin/pi"
chmod +x "$managed/bin/pi"
printf '{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}\n' > "$managed/install/managed-install.json"
printf '0.87.1\n' > "$managed/install/current-version"
printf '#!/usr/bin/env node\n' > "$active/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
printf '{"name":"@earendil-works/pi-coding-agent"}\n' > "$active/node_modules/@earendil-works/pi-coding-agent/package.json"
chmod +x "$active/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
ln -s ../@earendil-works/pi-coding-agent/dist/cli.js "$active/node_modules/.bin/pi"
printf '{"version":"decoy"}\n' > "$managed/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"active"}\n' > "$active/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"stale"}\n' > "$stale/node_modules/@earendil-works/pi-ai/package.json"
run_installer "$managed/bin" "$managed/captured"
expected="$(readlink -f "$active/node_modules/@earendil-works/pi-ai")
$(readlink -f "$active/node_modules/@earendil-works/pi-coding-agent")"
actual="$(cat "$managed/captured")"
[ "$actual" = "$expected" ] || {
    echo "managed: expected PI_AI_ROOT + PI_CODING_AGENT_ROOT=$expected, got $actual" >&2
    exit 1
}

# Missing active dependency must not escape the release and select the ancestor decoy.
rm -rf "$active/node_modules/@earendil-works/pi-ai"
if run_installer "$managed/bin" "$managed/missing-captured" > "$managed/missing-error" 2>&1; then
    echo "managed: missing active pi-ai unexpectedly selected ancestor decoy" >&2
    exit 1
fi
grep -F "Pi AI package not found from managed Pi executable" "$managed/missing-error" >/dev/null

# Malformed managed state must fail closed instead of scanning another release.
printf '../0.86.1\n' > "$managed/install/current-version"
if run_installer "$managed/bin" "$managed/invalid-captured" > "$managed/error" 2>&1; then
    echo "managed: malformed current-version unexpectedly succeeded" >&2
    exit 1
fi
grep -F "Managed Pi current version is missing or invalid" "$managed/error" >/dev/null

# Pre-0.87 Pi (install-pi.sh order): version warning, patch skipped, installer continues.
old="$FIXTURE/old-pi"
mkdir -p "$old/pi-root/dist" "$old/pi-root/node_modules/@earendil-works/pi-ai/dist/utils" "$old/bin"
printf '#!/usr/bin/env bash\necho 0.86.1\n' > "$old/pi-root/dist/cli.js"
chmod +x "$old/pi-root/dist/cli.js"
printf '{"version":"0.86.1"}\n' > "$old/pi-root/node_modules/@earendil-works/pi-ai/package.json"
printf '{"name":"@earendil-works/pi-coding-agent","version":"0.86.1"}\n' > "$old/pi-root/package.json"
cp "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$old/pi-root/node_modules/@earendil-works/pi-ai/dist/utils/retry.js"
ln -s "$old/pi-root/dist/cli.js" "$old/bin/pi"
if ! out="$(PATH="$old/bin:$PATH" REPO="$REPO" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      warn_if_pi_too_old
      install_pi_azure_response_retry_patch
      echo "CONTINUED"
    ' 2>&1)"; then
    echo "old pi: installer aborted: $out" >&2
    exit 1
fi
for expected in "WARNING: pi 0.86.1 is older than the supported minimum" \
    "SKIPPED: Pi Azure retry patch for pi-ai dist/utils/retry.js (SDK) (pi-ai 0.86.1 predates" \
    "SKIPPED: Pi Azure retry patch for pi CLI bundle (pi-coding-agent 0.86.1 predates" "CONTINUED"; do
    [[ "$out" == *"$expected"* ]] || { echo "old pi: missing '$expected' in: $out" >&2; exit 1; }
done
[[ "$out" != *"Error"* && "$out" != *"ERROR"* ]] || { echo "old pi: unexpected error output: $out" >&2; exit 1; }
cmp -s "$REPO/test/fixtures/pi-ai-0.87.1-retry.js" "$old/pi-root/node_modules/@earendil-works/pi-ai/dist/utils/retry.js"

# Root-owned Pi, installer run as a normal user (real node + real patch script;
# bundle skipped via a pre-0.87.1 agent version so the production pins apply).
if [ "$(id -u)" -eq 0 ]; then
    echo "SKIP: unwritable-install cases (running as root, chmod does not block writes)"
else
    locked="$FIXTURE/root-owned"
    pi_ai="$locked/pi-root/node_modules/@earendil-works/pi-ai"
    mkdir -p "$locked/pi-root/dist" "$pi_ai/dist/utils" "$locked/bin"
    printf '#!/usr/bin/env bash\necho 0.99.1\n' > "$locked/pi-root/dist/cli.js"
    chmod +x "$locked/pi-root/dist/cli.js"
    printf '{"name":"@earendil-works/pi-coding-agent","version":"0.86.1"}\n' > "$locked/pi-root/package.json"
    printf '{"version":"0.99.1"}\n' > "$pi_ai/package.json"
    cp "$REPO/test/fixtures/pi-ai-0.99.1-retry.js" "$pi_ai/dist/utils/retry.js"
    ln -s "$locked/pi-root/dist/cli.js" "$locked/bin/pi"
    chmod -R a-w "$locked/pi-root"
    run_locked() { # install-pi.sh order: patch, later per-user steps, final report
        PATH="$locked/bin:$PATH" REPO="$REPO" bash -euo pipefail -c '
          . "$REPO/lib/install-common.sh"
          install_pi_azure_response_retry_patch
          echo "CONTINUED"
          report_pending_pi_azure_patch
        ' 2>&1
    }
    rc=0
    out="$(run_locked)" || rc=$?
    [ "$rc" = 1 ] || { echo "root-owned: expected deferred exit 1, got $rc: $out" >&2; exit 1; }
    cmd="sudo env PI_AI_ROOT=$(readlink -f "$pi_ai") PI_CODING_AGENT_ROOT=$(readlink -f "$locked/pi-root") $REAL_NODE $REPO/pi/patches/pi-azure-response-failed-retry.cjs"
    for expected in "not writable by this user" "CONTINUED" "ERROR: Pi Azure retry patch NOT applied" \
        "    $cmd"$'\n' "re-run ./install-pi.sh WITHOUT sudo"; do
        [[ "$out" == *"$expected"* ]] || { echo "root-owned: missing '$expected' in: $out" >&2; exit 1; }
    done
    [ "$(grep -cF "    $cmd" <<<"$out")" = 2 ] || { echo "root-owned: command not repeated at the end: $out" >&2; exit 1; }
    [[ "$out" != *"sudo ./install-pi.sh"* ]] || { echo "root-owned: suggests sudo ./install-pi.sh: $out" >&2; exit 1; }
    cmp -s "$REPO/test/fixtures/pi-ai-0.99.1-retry.js" "$pi_ai/dist/utils/retry.js"
    [ ! -e "$pi_ai/dist/utils/retry.js.pre-terminal-setup-backup" ]
    # The printed command is copy-pasteable: run it as "root" (write access restored).
    chmod -R u+w "$locked/pi-root"
    eval "${cmd#sudo }" > /dev/null
    if cmp -s "$REPO/test/fixtures/pi-ai-0.99.1-retry.js" "$pi_ai/dist/utils/retry.js"; then
        echo "root-owned: printed command did not apply the patch" >&2
        exit 1
    fi
    # Already applied + still root-owned: plain success, no write needed.
    chmod -R a-w "$locked/pi-root"
    out="$(run_locked)" || { echo "root-owned already-applied: installer failed: $out" >&2; exit 1; }
    [[ "$out" == *"already applied: pi-ai dist/utils/retry.js (SDK)."*"CONTINUED"* ]] \
        || { echo "root-owned already-applied: $out" >&2; exit 1; }
    [[ "$out" != *"ERROR"* && "$out" != *"sudo"* ]] || { echo "root-owned already-applied: $out" >&2; exit 1; }
fi

# sudo ./install-pi.sh warns (per-user steps would act as root); plain root does not.
fake_id="$FIXTURE/fake-id"
mkdir -p "$fake_id"
printf '#!/bin/sh\necho 0\n' > "$fake_id/id"
chmod +x "$fake_id/id"
sudo_warning() { # <SUDO_USER value or empty>
    SUDO_USER="$1" PATH="$fake_id:$PATH" REPO="$REPO" bash -euo pipefail -c '
      . "$REPO/lib/install-common.sh"
      warn_if_run_with_sudo
    ' 2>&1
}
out="$(sudo_warning alice)"
[[ "$out" == *"WARNING: install-pi.sh is running as root via sudo (SUDO_USER=alice)"*"Run it without sudo"* ]] \
    || { echo "sudo warning missing: $out" >&2; exit 1; }
out="$(sudo_warning "")"
[ -z "$out" ] || { echo "plain root must not warn: $out" >&2; exit 1; }

printf 'PASS: installer resolves legacy and managed Pi AI + coding-agent paths\n'
