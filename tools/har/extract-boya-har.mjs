#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAssetsFromHarFile } from "../lib/boya-har.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {
    har: path.join(repoRoot, "麻将2 boya.har"),
    out: path.join(repoRoot, "local-har-client/boya-mahjong2")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--har") {
      args.har = argv[++index];
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node tools/har/extract-boya-har.mjs --har "麻将2 boya.har" --out local-har-client/boya-mahjong2`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await extractAssetsFromHarFile(args.har, args.out);
  console.log(JSON.stringify({
    ok: true,
    har: args.har,
    out: args.out,
    written: result.written,
    contentTypes: result.summary.contentTypes
  }, null, 2));
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
