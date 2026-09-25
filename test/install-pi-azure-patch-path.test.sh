#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
REAL_NODE="$(command -v node)"
trap 'rm -rf "$FIXTURE"' EXIT

make_node_stub() { # <bin-dir>
    mkdir -p "$1"
    cat > "$1/node" <<'NODE'
#!/usr/bin/env bash
if [ -n "${PI_AI_ROOT-}" ]; then
  printf '%s\n' "$PI_AI_ROOT" > "$NODE_ENV_CAPTURE"
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
printf '{"version":"fixture"}\n' > "$legacy/pi-root/node_modules/@earendil-works/pi-ai/package.json"
ln -s "$legacy/pi-root/dist/cli.js" "$legacy/bin/pi"
make_node_stub "$legacy/bin"
run_installer "$legacy/bin" "$legacy/captured"
expected="$(readlink -f "$legacy/pi-root/node_modules/@earendil-works/pi-ai")"
actual="$(cat "$legacy/captured")"
[ "$actual" = "$expected" ] || {
    echo "legacy: expected PI_AI_ROOT=$expected, got $actual" >&2
    exit 1
}

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
chmod +x "$active/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
ln -s ../@earendil-works/pi-coding-agent/dist/cli.js "$active/node_modules/.bin/pi"
printf '{"version":"decoy"}\n' > "$managed/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"active"}\n' > "$active/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"stale"}\n' > "$stale/node_modules/@earendil-works/pi-ai/package.json"
run_installer "$managed/bin" "$managed/captured"
expected="$(readlink -f "$active/node_modules/@earendil-works/pi-ai")"
actual="$(cat "$managed/captured")"
[ "$actual" = "$expected" ] || {
    echo "managed: expected PI_AI_ROOT=$expected, got $actual" >&2
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

printf 'PASS: installer resolves legacy and managed Pi AI paths\n'
