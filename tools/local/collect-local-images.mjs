#!/usr/bin/env node
import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browserImageCategory, repairBrowserImageBytes } from "../lib/local-image-export.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {
    root: path.join(repoRoot, "local-har-client/boya-mahjong2"),
    out: path.join(repoRoot, "image")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = argv[++index];
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
  node tools/local/collect-local-images.mjs --root local-har-client/boya-mahjong2 --out image`);
}

function outputName(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  const base = path.basename(localPath, ext)
    .replaceAll(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 72);
  const digest = crypto.createHash("sha1").update(localPath).digest("hex").slice(0, 8);
  return `${base}.${digest}${ext || ".img"}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = Object.entries(manifest.files || {})
    .map(([localPath, meta]) => ({
      localPath,
      meta,
      category: browserImageCategory(meta.contentType, localPath)
    }))
    .filter((entry) => entry.category)
    .sort((left, right) => left.localPath.localeCompare(right.localPath));

  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });

  const copied = [];
  const counts = {};
  for (const entry of entries) {
    const from = path.join(args.root, entry.localPath);
    const name = outputName(entry.localPath);
    const toRelative = path.join(entry.category, name);
    const to = path.join(args.out, toRelative);
    const bytes = repairBrowserImageBytes(await readFile(from), entry.meta.contentType, entry.localPath);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, bytes);
    counts[entry.category] = (counts[entry.category] || 0) + 1;
    copied.push({
      category: entry.category,
      file: toRelative,
      sourceLocalPath: entry.localPath,
      sourceUrl: entry.meta.sourceUrl,
      contentType: entry.meta.contentType,
      bytes: bytes.length
    });
  }

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: path.resolve(args.root),
    outputRoot: path.resolve(args.out),
    total: copied.length,
    counts,
    files: copied
  };

  await writeFile(path.join(args.out, "manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(args.out, "README.md"), buildReadme(summary), "utf8");
  console.log(JSON.stringify({
    ok: true,
    outputRoot: summary.outputRoot,
    total: summary.total,
    counts: summary.counts
  }, null, 2));
}

function buildReadme(summary) {
  const lines = [
    "# Boya Mahjong2 Local Images",
    "",
    "这些图片从本地 HAR 还原目录复制而来，用于快速确认素材已经落在本机。",
    "",
    `- sourceRoot: ${summary.sourceRoot}`,
    `- outputRoot: ${summary.outputRoot}`,
    `- total: ${summary.total}`,
    "",
    "## 分类",
    ""
  ];

  for (const [category, count] of Object.entries(summary.counts).sort()) {
    lines.push(`- image/${category}: ${count}`);
  }

  lines.push("", "完整来源映射见 `manifest.json`。", "");
  return `${lines.join("\n")}`;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
