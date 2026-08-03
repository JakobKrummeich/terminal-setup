#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/pi-root/dist" "$FIXTURE/bin"
printf '#!/usr/bin/env bash\n' > "$FIXTURE/pi-root/dist/cli.js"
chmod +x "$FIXTURE/pi-root/dist/cli.js"
ln -s "$FIXTURE/pi-root/dist/cli.js" "$FIXTURE/bin/pi"
cat > "$FIXTURE/bin/node" <<'NODE'
#!/usr/bin/env bash
printf '%s\n' "${PI_AI_ROOT-}" > "$NODE_ENV_CAPTURE"
NODE
chmod +x "$FIXTURE/bin/node"

NODE_ENV_CAPTURE="$FIXTURE/pi-ai-root" PATH="$FIXTURE/bin:$PATH" REPO="$REPO" bash -c '
  . "$REPO/lib/install-common.sh"
  install_pi_azure_response_retry_patch
'
expected="$FIXTURE/pi-root/node_modules/@earendil-works/pi-ai"
actual="$(cat "$FIXTURE/pi-ai-root")"
[ "$actual" = "$expected" ] || {
  echo "expected PI_AI_ROOT=$expected, got $actual" >&2
  exit 1
}
echo "PASS: installer passes resolved Pi AI path"
