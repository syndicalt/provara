#!/usr/bin/env node
// Copy the gateway's OpenAPI spec into the web app's public dir so the
// docs page can serve it at /openapi.yaml. Runs as predev + prebuild.
// Source of truth: packages/gateway/openapi.yaml.

import { cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = resolve(__dirname, "../../../packages/gateway/openapi.yaml");
const dest = resolve(__dirname, "../public/openapi.yaml");

if (!existsSync(source)) {
  console.error(`[sync-openapi] source not found: ${source}`);
  process.exit(1);
}

cpSync(source, dest);
console.log(`[sync-openapi] ${source} → ${dest}`);
