#!/usr/bin/env node
/*
 * Temporary Pi workaround: Azure Responses can send response.failed
 * without details during a transient throttle. Remove after upstream handles it.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const expectedHashesByVersion = new Map([
  ["0.83.0", {
    baseline: "916476be8a85ad16f9de3d0cfc3eb341b3290445fde3717593b139fd7ee31b7b",
    patched: "555af17d9090d1e1c01c9c18b6fff771cf313b83ce79805acffb64e5bfb1394b",
  }],
  ["0.84.1", {
    baseline: "916476be8a85ad16f9de3d0cfc3eb341b3290445fde3717593b139fd7ee31b7b",
    patched: "555af17d9090d1e1c01c9c18b6fff771cf313b83ce79805acffb64e5bfb1394b",
  }],
  ["0.84.2", {
    baseline: "72f0a6f7271841f24154b87c368024a779cd77436be4fb163276ca21849490a3",
    patched: "04ccf92f92f9d669cd6dd77ce47faacbadb34cf73fe73ac9fc39439ec5365931",
  }],
  ["0.84.3", {
    // Verified identical to 0.84.2 before patch; keep an explicit upgrade guard.
    baseline: "72f0a6f7271841f24154b87c368024a779cd77436be4fb163276ca21849490a3",
    patched: "04ccf92f92f9d669cd6dd77ce47faacbadb34cf73fe73ac9fc39439ec5365931",
  }],
  ["0.84.4", {
    // Verified identical to 0.84.2 before patch; keep an explicit upgrade guard.
    baseline: "72f0a6f7271841f24154b87c368024a779cd77436be4fb163276ca21849490a3",
    patched: "04ccf92f92f9d669cd6dd77ce47faacbadb34cf73fe73ac9fc39439ec5365931",
  }],
  ["0.85.1", {
    // Verified against the 0.85.1 npm package; keep an explicit upgrade guard.
    baseline: "9e344f7662b334de0cbc7e7eccf0faa5f3c645a50b5fd8383495df700841f81e",
    patched: "ca288d102a4525c05ac3b731823f6f398b96bc562793e84decb73e27d0ab3492",
  }],
  ["0.86.1", {
    // Upstream still maps Azure response.failed without details to the same
    // hidden error, and retry.js has no Azure-specific classifier yet.
    baseline: "292e2a6654fdd48d6f020eedb2084a70b3ccceb289c37c65ad2d41c45dc664dc",
    patched: "10121b3f352678884b2841d09e3578581b874964577db706c387d471bed9fce4",
  }],
]);
const before = `    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);`;
const after = `    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    // Azure may emit response.failed without error details for a transient throttle.\n    if (message.provider === "azure-openai-responses"\n        && message.rawStopReason === "failed"\n        && errorMessage === "Unknown error (no error details in response)")\n        return true;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);`;

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const piAiRoot = process.env.PI_AI_ROOT;
if (!piAiRoot) throw new Error("PI_AI_ROOT is required; run install-pi.sh.");
const packageJsonPath = path.join(piAiRoot, "package.json");
const retryPath = path.join(piAiRoot, "dist", "utils", "retry.js");
if (!fs.existsSync(packageJsonPath) || !fs.existsSync(retryPath)) {
  throw new Error(`Pi AI files not found below ${piAiRoot}; patch not applied.`);
}
const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
const expectedHashes = expectedHashesByVersion.get(version);
if (!expectedHashes) throw new Error(`Expected pi-ai one of ${[...expectedHashesByVersion.keys()].join(", ")}, found ${version}; patch not applied.`);
const source = fs.readFileSync(retryPath, "utf8");
if (sha256(source) === expectedHashes.patched) {
  console.log("Pi Azure hidden-response retry patch already applied.");
  process.exit(0);
}
if (sha256(source) !== expectedHashes.baseline || !source.includes(before)) {
  throw new Error("Unexpected pi-ai retry classifier; patch not applied.");
}
const patched = source.replace(before, after);
if (sha256(patched) !== expectedHashes.patched) throw new Error("Patched pi-ai hash mismatch; patch not applied.");
fs.copyFileSync(retryPath, `${retryPath}.pre-terminal-setup-backup`);
fs.writeFileSync(retryPath, patched);
console.log("Applied Pi Azure hidden-response retry patch.");
