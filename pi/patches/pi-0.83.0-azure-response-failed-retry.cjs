#!/usr/bin/env node
/*
 * Temporary Pi 0.83.0 workaround: Azure Responses can send response.failed
 * without details during a transient throttle. Remove after upstream handles it.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const expectedVersion = "0.83.0";
const baselineSha256 = "916476be8a85ad16f9de3d0cfc3eb341b3290445fde3717593b139fd7ee31b7b";
const patchedSha256 = "555af17d9090d1e1c01c9c18b6fff771cf313b83ce79805acffb64e5bfb1394b";
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
  throw new Error(`Pi 0.83.0 files not found below ${piAiRoot}; patch not applied.`);
}
const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
if (version !== expectedVersion) throw new Error(`Expected pi-ai ${expectedVersion}, found ${version}; patch not applied.`);
const source = fs.readFileSync(retryPath, "utf8");
if (sha256(source) === patchedSha256) {
  console.log("Pi Azure hidden-response retry patch already applied.");
  process.exit(0);
}
if (sha256(source) !== baselineSha256 || !source.includes(before)) {
  throw new Error("Unexpected pi-ai retry classifier; patch not applied.");
}
const patched = source.replace(before, after);
if (sha256(patched) !== patchedSha256) throw new Error("Patched pi-ai hash mismatch; patch not applied.");
fs.copyFileSync(retryPath, `${retryPath}.pre-terminal-setup-backup`);
fs.writeFileSync(retryPath, patched);
console.log("Applied Pi Azure hidden-response retry patch.");
