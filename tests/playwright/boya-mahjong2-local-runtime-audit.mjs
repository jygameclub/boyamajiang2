#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { waitForGameCanvas } from "./boya-observed-frame.mjs";

function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18082", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") args.baseUrl = argv[++index];
    else if (argv[index] === "--out") args.out = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

function isAllowedRuntimeUrl(value, baseUrl) {
  const url = new URL(value);
  if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
  const base = new URL(baseUrl);
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol)
    && url.hostname === base.hostname
    && url.port === base.port;
}

async function auditPage({ browser, baseUrl, pathname, name, game = false, expectedUrl = null, out }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  const page = await context.newPage();
  const requests = [];
  const responses = [];
  const websockets = [];
  const failedRequests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
  page.on("response", (response) => responses.push({ url: response.url(), status: response.status() }));
  page.on("requestfailed", (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText || "request failed"
  }));
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("websocket", (socket) => websockets.push(socket.url()));

  await page.goto(new URL(pathname, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
  let canvasVisible = false;
  if (game) {
    await waitForGameCanvas(page);
    canvasVisible = true;
    await page.waitForTimeout(2500);
    await page.mouse.click(450, 1075);
    await page.waitForTimeout(7000);
    await page.mouse.click(450, 1315);
    await page.waitForTimeout(9000);
  } else {
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  const finalUrl = page.url();
  const allUrls = [...requests.map((entry) => entry.url), ...websockets];
  const externalUrls = [...new Set(allUrls.filter((url) => !isAllowedRuntimeUrl(url, baseUrl)))];
  const httpErrors = responses.filter((response) => response.status >= 400);
  await context.close();
  return {
    name,
    pathname,
    finalUrl,
    expectedUrl,
    canvasVisible,
    requestCount: requests.length,
    responseCount: responses.length,
    websocketCount: websockets.length,
    hosts: [...new Set(allUrls.map((value) => {
      const url = new URL(value);
      return url.host || url.protocol;
    }))].sort(),
    externalUrls,
    failedRequests,
    httpErrors,
    pageErrors,
    verdict: externalUrls.length === 0
      && failedRequests.length === 0
      && httpErrors.length === 0
      && pageErrors.length === 0
      && (!game || canvasVisible)
      && (!expectedUrl || finalUrl === expectedUrl)
      ? "PASS"
      : "FAIL"
  };
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
});
const report = { baseUrl: args.baseUrl, pages: [], verdict: "FAIL" };

try {
  const livePath = "/__game/live?token=audit-user";
  report.pages.push(await auditPage({
    browser,
    baseUrl: args.baseUrl,
    pathname: "/__game/test",
    name: "test-client",
    game: true,
    expectedUrl: new URL("/__game/test", args.baseUrl).toString(),
    out: args.out
  }));
  report.pages.push(await auditPage({
    browser,
    baseUrl: args.baseUrl,
    pathname: livePath,
    name: "live-client",
    game: true,
    expectedUrl: new URL(livePath, args.baseUrl).toString(),
    out: args.out
  }));
  report.pages.push(await auditPage({
    browser,
    baseUrl: args.baseUrl,
    pathname: "/__admin",
    name: "admin",
    out: args.out
  }));
  report.pages.push(await auditPage({
    browser,
    baseUrl: args.baseUrl,
    pathname: "/__history",
    name: "history",
    out: args.out
  }));
  report.verdict = report.pages.every((page) => page.verdict === "PASS") ? "PASS" : "FAIL";
} catch (error) {
  report.error = error.stack || error.message;
} finally {
  await browser.close();
  await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    "# Boya Mahjong2 local runtime audit",
    "",
    `- verdict: ${report.verdict}`,
    `- baseUrl: ${report.baseUrl}`,
    `- error: ${report.error || "none"}`,
    "",
    ...report.pages.map((page) => (
      `- ${page.name}: ${page.verdict}, requests=${page.requestCount}, websockets=${page.websocketCount}, hosts=${page.hosts.join(",")}, external=${page.externalUrls.length}, HTTP>=400=${page.httpErrors.length}, failed=${page.failedRequests.length}`
    )),
    ""
  ].join("\n");
  await writeFile(path.join(args.out, "report.md"), markdown);
}

if (report.verdict !== "PASS") process.exitCode = 1;
