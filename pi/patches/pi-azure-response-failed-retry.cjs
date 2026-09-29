#!/usr/bin/env node
/*
 * Temporary Pi workaround: Azure Responses can send response.failed
 * without details during a transient throttle. Remove after upstream handles it.
 *
 * pi-ai's retry classifier exists twice in an installed Pi, and both copies
 * are patched:
 *   - pi-ai dist/utils/retry.js — what SDK users (and the extension tests)
 *     load through @earendil-works/pi-coding-agent's unbundled dist;
 *   - the `pi` CLI's bundle (dist/bundle/cli.js, since Pi 0.84.3) inlines its
 *     own minified copy into one content-hashed dist/bundle/chunks/chunk-*.js.
 *     Found by content (the one bundle file using
 *     NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), not by file name.
 * Fail-closed: every file must hash to the pinned baseline (-> patch) or
 * patched (-> already done) value of its package version; unknown versions,
 * unexpected content, or an ambiguous bundle abort before ANY file is written.
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// sha256 per Pi version, per target. Upstream (0.99.0) still maps Azure
// response.failed without details to the same hidden error, and the classifier
// has no Azure-specific branch yet.
const EXPECTED_HASHES = new Map([
  ["0.87.1", {
    retry: {
      baseline: "292e2a6654fdd48d6f020eedb2084a70b3ccceb289c37c65ad2d41c45dc664dc",
      patched: "10121b3f352678884b2841d09e3578581b874964577db706c387d471bed9fce4",
    },
    bundle: { // dist/bundle/chunks/chunk-OJP47DM6.js
      baseline: "81c81a21ec81e84200205f561687408ff5e3738fbbbb3c2a6c186b348d376020",
      patched: "b8bb99baccb357ef0497bf47e2ac54dbc7ffea7eb6b320571b8d0892176315a0",
    },
  }],
  ["0.99.0", {
    retry: {
      baseline: "ae91b950515c239d8bbae9e6a85074b10d5ae4195b20effa228ea51898c0658d",
      patched: "c088b8a265306a252b851e926112d66e7cec2503175a8d883b3fca27eac64c68",
    },
    bundle: { // dist/bundle/chunks/chunk-4CSSZFEW.js
      baseline: "dba68f1ea740414a4bc4a1d7806bc418baf6e7fe67e54582ca5325ae21025862",
      patched: "9b81185816f29b28c2ba7c4072e7fba2adf0f5126c6d87b0f61cc774b328b63e",
    },
  }],
]);

const RETRY_BEFORE = `    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);`;
const RETRY_AFTER = `    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    // Azure may emit response.failed without error details for a transient throttle.\n    if (message.provider === "azure-openai-responses"\n        && message.rawStopReason === "failed"\n        && errorMessage === "Unknown error (no error details in response)")\n        return true;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);`;

// The bundler minifies whitespace and renames the local (errorMessage3 on
// 0.87.1, errorMessage4 on 0.99.0), so the bundle copy is matched as the whole
// verbatim function with the local captured.
const BUNDLE_MARKER = "NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(";
const BUNDLE_BEFORE = /function isRetryableAssistantError\(message\)\{if\(message\.stopReason!=="error"\|\|!message\.errorMessage\)return!1;let (errorMessage\d*)=message\.errorMessage;return NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN\.test\(\1\)\?!1:RETRYABLE_PROVIDER_ERROR_PATTERN\.test\(\1\)\}/g;
const bundleAfter = (v) =>
  `function isRetryableAssistantError(message){if(message.stopReason!=="error"||!message.errorMessage)return!1;let ${v}=message.errorMessage;return NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(${v})?!1:/* terminal-setup: Azure response.failed without details = transient throttle */message.provider==="azure-openai-responses"&&message.rawStopReason==="failed"&&${v}==="Unknown error (no error details in response)"?!0:RETRYABLE_PROVIDER_ERROR_PATTERN.test(${v})}`;

const sha256 = (content) => crypto.createHash("sha256").update(content).digest("hex");

/** source with the single occurrence of `before` replaced, or undefined unless exactly one. */
function replaceOnce(source, before, after) {
  const count = typeof before === "string" ? source.split(before).length - 1 : (source.match(before) || []).length;
  return count === 1 ? source.replace(before, after) : undefined;
}

function bundleFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return bundleFiles(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

function locateBundleChunk(agentRoot) {
  const bundleDir = path.join(agentRoot, "dist", "bundle");
  const hits = bundleFiles(bundleDir).filter((file) => fs.readFileSync(file, "utf8").includes(BUNDLE_MARKER));
  if (hits.length !== 1) {
    throw new Error(`Expected exactly one retry classifier in ${bundleDir}, found ${hits.length}; patch not applied.`);
  }
  return hits[0];
}

const TARGETS = [
  {
    key: "retry",
    envVar: "PI_AI_ROOT",
    pkg: "pi-ai",
    label: "pi-ai dist/utils/retry.js (SDK)",
    locate: (root) => path.join(root, "dist", "utils", "retry.js"),
    transform: (source) => replaceOnce(source, RETRY_BEFORE, RETRY_AFTER),
  },
  {
    key: "bundle",
    envVar: "PI_CODING_AGENT_ROOT",
    pkg: "pi-coding-agent",
    label: "pi CLI bundle",
    locate: locateBundleChunk,
    transform: (source) => replaceOnce(source, BUNDLE_BEFORE, (_match, v) => bundleAfter(v)),
  },
];

const numericParts = (v) => /^\d+\.\d+\.\d+(?:$|[-+])/.test(v) ? v.split(/[-+]/)[0].split(".").map(Number) : undefined;
function isOlder(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
/** Older than every hashed version (pre-0.87.1 Pi): nothing to patch. Newer unknown versions fail. */
function predatesAll(version, table) {
  const found = typeof version === "string" ? numericParts(version) : undefined;
  return found !== undefined && [...table.keys()].every((known) => isOlder(found, numericParts(known)));
}

function readVersion(root, pkg) {
  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) throw new Error(`${pkg} package.json not found below ${root}; patch not applied.`);
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
}

/** Decide one target without writing: skip | already | apply (throws on anything unexpected). */
function plan(target, root, table) {
  const version = readVersion(root, target.pkg);
  const known = [...table.keys()].join(", ");
  const hashes = table.get(version)?.[target.key];
  if (!hashes && predatesAll(version, table)) {
    return { target, action: "skip", note: `${target.pkg} ${version} predates the patched ${known}` };
  }
  if (!hashes) throw new Error(`Expected ${target.pkg} one of ${known}, found ${version}; patch not applied.`);
  const file = target.locate(root);
  if (!fs.existsSync(file)) throw new Error(`${target.label} not found at ${file}; patch not applied.`);
  const source = fs.readFileSync(file, "utf8");
  const hash = sha256(source);
  if (hash === hashes.patched) return { target, action: "already", file };
  if (hash !== hashes.baseline) {
    throw new Error(`Unexpected ${target.label} ${file} (sha256 ${hash}, not ${target.pkg} ${version}); patch not applied.`);
  }
  const patched = target.transform(source);
  if (patched === undefined || sha256(patched) !== hashes.patched) {
    throw new Error(`Patched ${target.label} hash mismatch for ${target.pkg} ${version}; patch not applied.`);
  }
  return { target, action: "apply", file, patched };
}

function main(env = process.env, table = EXPECTED_HASHES, log = console.log) {
  const roots = TARGETS.map((target) => {
    if (!env[target.envVar]) throw new Error(`${target.envVar} is required; run install-pi.sh.`);
    return env[target.envVar];
  });
  // Plan every target first: a failure anywhere leaves every file untouched.
  const plans = TARGETS.map((target, i) => plan(target, roots[i], table));
  for (const { target, action, file, patched, note } of plans) {
    if (action === "skip") {
      log(`SKIPPED: Pi Azure retry patch for ${target.label} (${note}; untouched).`);
    } else if (action === "already") {
      log(`Pi Azure hidden-response retry patch already applied: ${target.label}.`);
    } else {
      fs.copyFileSync(file, `${file}.pre-terminal-setup-backup`);
      fs.writeFileSync(file, patched);
      log(`Applied Pi Azure hidden-response retry patch: ${target.label} (${file}).`);
    }
  }
}

module.exports = { EXPECTED_HASHES, TARGETS, main, sha256 };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
