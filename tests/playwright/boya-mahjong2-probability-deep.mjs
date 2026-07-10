#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { PLAYABLE_INDEXES } from "../../tools/local/engine/constants.mjs";
import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";
import {
  clickSequenceUntilObservedFrame,
  clickUntilObservedFrame,
  collectRotateSequence,
  decodeObservedFrame,
  waitForGameCanvas,
  waitForObservedFrame
} from "./boya-observed-frame.mjs";

const SYMBOLS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
const FREE_COUNTS = new Map([[3, 10], [4, 12], [5, 14], [6, 15]]);

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

async function api(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.data;
}

function bindPage(page, diagnostics, frames) {
  let active = true;
  page.on("console", (message) => diagnostics.console.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
  });
  page.on("requestfailed", (request) => diagnostics.requestFailures.push({
    url: request.url(),
    error: request.failure()?.errorText || "request failed"
  }));
  page.on("websocket", (socket) => {
    for (const [eventName, direction] of [["framesent", "send"], ["framereceived", "receive"]]) {
      socket.on(eventName, (event) => {
        const frame = decodeObservedFrame(direction, event.payload, frames.length + 1);
        if (!frame) return;
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      });
    }
    socket.on("close", () => {
      if (active) diagnostics.clientCloses.push(socket.url());
    });
  });
  return () => { active = false; };
}

async function openGame(context, url, diagnostics, frames) {
  const page = await context.newPage();
  const deactivate = bindPage(page, diagnostics, frames);
  const start = frames.length;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForGameCanvas(page);
  await waitForObservedFrame(
    frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40001,
    90000,
    "game enter"
  );
  await page.waitForTimeout(2200);
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(1800);
  return { page, deactivate };
}

async function closeGame(opened) {
  opened.deactivate();
  await opened.page.close();
}

async function activateConfig(baseUrl, name, payload) {
  const draft = await api(baseUrl, "/api/admin/config/drafts", {
    method: "POST",
    body: JSON.stringify({ name, payload })
  });
  await api(baseUrl, `/api/admin/config/drafts/${draft.id}/validate`, { method: "POST" });
  return api(baseUrl, `/api/admin/config/drafts/${draft.id}/activate`, { method: "POST" });
}

function forcedBandConfig(source, target, symbol) {
  const payload = structuredClone(source);
  payload.modes.base.outcomeWeights = Object.fromEntries(
    ["miss", "small", "medium", "big", "mega", "super"].map((key) => [key, key === target ? 1 : 0])
  );
  payload.modes.base.scatterCap = 0;
  payload.modes.base.initial.goldRateByReel = [0, 0, 0, 0, 0];
  payload.modes.base.initial.symbolWeights = [symbol, symbol, symbol, 3, 5].map((entry) => ({ [entry]: 1 }));
  payload.modes.base.cascade.goldRateByReel = [0, 0, 0, 0, 0];
  payload.modes.base.cascade.symbolWeights = [3, 5, 7, 9, 11].map((entry) => ({ [entry]: 1 }));
  return payload;
}

function publicLines(lines) {
  return lines.map(({ iconId, axleId, lineNum, score, multi, odds }) => ({
    iconId,
    axleId,
    lineNum,
    score,
    multi,
    odds
  })).sort((left, right) => left.iconId - right.iconId);
}

function validateRotate(rotate, mode, cascadeIndex) {
  const calculated = calculateWays(rotate.drawResult, {
    betMulti: rotate.betMulti,
    multiplier: rotate.gameNum,
    mode,
    cascadeIndex
  });
  return JSON.stringify(publicLines(rotate.lines)) === JSON.stringify(publicLines(calculated.lines))
    && rotate.roundWin === calculated.roundWin
    && rotate.lines.reduce((sum, line) => sum + line.score, 0) === rotate.roundWin;
}

async function verifyOutcomeBands({ opened, baseUrl, out, frames, originalPayload, token }) {
  const definitions = [
    { outcome: "medium", symbol: 19, amount: 2000 },
    { outcome: "big", symbol: 15, amount: 4000 },
    { outcome: "mega", symbol: 9, amount: 10000 },
    { outcome: "super", symbol: 7, amount: 12000 }
  ];
  const results = [];
  for (const definition of definitions) {
    const config = forcedBandConfig(originalPayload, definition.outcome, definition.symbol);
    const active = await activateConfig(baseUrl, `deep-${definition.outcome}`, config);
    const start = frames.length;
    const request = await clickUntilObservedFrame({
      page: opened.page,
      frames,
      predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40002,
      x: 450,
      y: 1315,
      timeoutMs: 90000,
      intervalMs: 1000,
      label: `${definition.outcome} spin request`
    });
    const first = await waitForObservedFrame(
      frames,
      (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003,
      90000,
      `${definition.outcome} first response`
    );
    await opened.page.waitForTimeout(2800);
    await opened.page.screenshot({
      path: path.join(out, `outcome-${definition.outcome}-highlight.png`),
      fullPage: true
    });
    const sequence = await collectRotateSequence({
      frames,
      firstFrame: first,
      responseCmd: 40003,
      timeoutMs: 120000,
      label: `${definition.outcome} terminal response`
    });
    const history = await api(
      baseUrl,
      `/api/history/rounds?mode=live&token=${encodeURIComponent(token)}&limit=20`
    );
    const round = history[0];
    const forcedColumns = [0, 1, 2].every((reel) => {
      const indexes = PLAYABLE_INDEXES.filter((index) => Math.floor(index / 5) === reel);
      return indexes.every((index) => first.rotate.drawResult[index] === definition.symbol);
    });
    results.push({
      ...definition,
      activeConfigId: active.id,
      historyConfigId: round?.configId ?? null,
      historyOutcome: round?.outcome ?? null,
      source: round?.source ?? null,
      roundWin: first.rotate.roundWin,
      lineCount: first.rotate.lines.length,
      lineWays: first.rotate.lines[0]?.lineNum ?? 0,
      forcedColumns,
      formulaMatches: sequence.every((frame, index) => validateRotate(frame.rotate, "base", index)),
      terminalLines: sequence.at(-1).rotate.lines.length,
      terminalRoundWin: sequence.at(-1).rotate.roundWin
    });
    await opened.page.waitForTimeout(1200);
  }
  return results;
}

async function setAdminInput(page, selector, value) {
  const field = page.locator(selector);
  await field.waitFor({ state: "visible" });
  await field.evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function configureBuyThroughAdmin({ browser, baseUrl, out, diagnostics }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
  });
  await page.goto(new URL("/__admin", baseUrl).toString(), { waitUntil: "networkidle" });
  await page.locator('#mode-control [data-mode="buy"]').click();
  await page.locator('#phase-control [data-phase="initial"]').click();
  const expectedByReel = [3, 5, 8, 9, 11];
  const configuredBaseSymbols = [3, 5, 7, 9, 11];
  for (let reel = 0; reel < 5; reel += 1) {
    for (const symbol of SYMBOLS) {
      await setAdminInput(page, `[data-weight-reel="${reel}"][data-weight-symbol="${symbol}"]`, 0);
    }
    await setAdminInput(
      page,
      `[data-weight-reel="${reel}"][data-weight-symbol="${configuredBaseSymbols[reel]}"]`,
      1
    );
  }
  await setAdminInput(page, '[data-gold-reel="1"]', 0);
  await setAdminInput(page, '[data-gold-reel="3"]', 0);
  await page.locator('#phase-control [data-phase="cascade"]').click();
  const configuredBufferSymbols = [19, 17, 15, 13, 11];
  for (let reel = 0; reel < 5; reel += 1) {
    for (const symbol of SYMBOLS) {
      await setAdminInput(page, `[data-weight-reel="${reel}"][data-weight-symbol="${symbol}"]`, 0);
    }
    await setAdminInput(
      page,
      `[data-weight-reel="${reel}"][data-weight-symbol="${configuredBufferSymbols[reel]}"]`,
      1
    );
  }
  await setAdminInput(page, '[data-gold-reel="1"]', 0);
  await setAdminInput(page, '[data-gold-reel="3"]', 0);
  await page.locator('.tab[data-tab="outcomes"]').click();
  for (const [key, value] of Object.entries({ scatter3: 0, scatter4: 1, scatter5: 0, scatter6plus: 0 })) {
    await setAdminInput(page, `[data-scatter="${key}"]`, value);
  }
  await page.locator('.tab[data-tab="weights"]').click();

  const saveResponse = page.waitForResponse((response) => (
    response.url().endsWith("/api/admin/config/drafts") && response.request().method() === "POST"
  ));
  await page.locator("#save-draft").click();
  if (!(await saveResponse).ok()) throw new Error("Admin draft save failed");
  const validateResponse = page.waitForResponse((response) => response.url().endsWith("/validate"));
  await page.locator("#validate-draft").click();
  if (!(await validateResponse).ok()) throw new Error("Admin draft validation failed");
  const activateResponse = page.waitForResponse((response) => response.url().endsWith("/activate"));
  await page.locator("#activate-draft").click();
  if (!(await activateResponse).ok()) throw new Error("Admin draft activation failed");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "admin-buy-config-activated.png"), fullPage: true });
  const active = await api(baseUrl, "/api/admin/config/active");
  await context.close();
  return { active, expectedByReel, expectedBuffers: [19, 17, 16, 13, 11] };
}

function buyConfigWithScatter(source, scatterCount) {
  const payload = structuredClone(source);
  payload.modes.buy.scatterWeights = {
    scatter3: scatterCount === 3 ? 1 : 0,
    scatter4: scatterCount === 4 ? 1 : 0,
    scatter5: scatterCount === 5 ? 1 : 0,
    scatter6plus: scatterCount === 6 ? 1 : 0
  };
  return payload;
}

async function verifyBuyCases({
  context,
  baseUrl,
  out,
  diagnostics,
  frames,
  uiActive,
  expectedByReel,
  expectedBuffers
}) {
  const results = [];
  for (const scatterCount of [4, 3, 5, 6]) {
    const active = scatterCount === 4
      ? uiActive
      : await activateConfig(baseUrl, `deep-buy-${scatterCount}`, buyConfigWithScatter(uiActive.payload, scatterCount));
    const token = `deep-buy-${scatterCount}`;
    const opened = await openGame(
      context,
      new URL(`/__game/live?token=${token}`, baseUrl).toString(),
      diagnostics,
      frames
    );
    const start = frames.length;
    const request = await clickSequenceUntilObservedFrame({
      page: opened.page,
      frames,
      predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40006,
      clicks: [{ x: 145, y: 1090 }, { x: 590, y: 1150 }],
      clickDelayMs: 900,
      timeoutMs: 45000,
      label: `buy ${scatterCount} request`
    });
    const trigger = await waitForObservedFrame(
      frames,
      (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40007,
      45000,
      `buy ${scatterCount} trigger`
    );
    await opened.page.waitForTimeout(1400);
    await opened.page.screenshot({
      path: path.join(out, `buy-scatter-${scatterCount}.png`),
      fullPage: true
    });
    const reelWeightsMatch = PLAYABLE_INDEXES.every((index) => {
      const symbol = trigger.rotate.drawResult[index];
      return symbol === 1 || symbol === expectedByReel[Math.floor(index / 5)];
    });
    const rounds = await api(baseUrl, `/api/history/rounds?mode=live&token=${token}&limit=5`);
    const buyRound = rounds.find((round) => round.kind === "buy");
    results.push({
      scatterCount,
      actualScatterCount: trigger.rotate.drawResult.filter((symbol) => symbol === 1).length,
      expectedFreeCount: FREE_COUNTS.get(scatterCount),
      actualFreeCount: trigger.rotate.freeRemainCount,
      activeConfigId: active.id,
      historyConfigId: buyRound?.configId ?? null,
      reelWeightsMatch,
      buffersMatch: JSON.stringify(trigger.rotate.topResult) === JSON.stringify(expectedBuffers)
        && JSON.stringify(trigger.rotate.buttomResult) === JSON.stringify(expectedBuffers)
    });
    await closeGame(opened);
  }
  return results;
}

function markdown(report) {
  return `${[
    "# Boya Mahjong2 Deep Probability Verification",
    "",
    `- verdict: ${report.verdict}`,
    `- baseUrl: ${report.baseUrl}`,
    `- error: ${report.error || "none"}`,
    `- HTTP >= 400: ${report.diagnostics.httpErrors.length}`,
    `- request failures: ${report.diagnostics.requestFailures.length}`,
    `- page errors: ${report.diagnostics.pageErrors.length}`,
    `- client closes: ${report.diagnostics.clientCloses.length}`,
    `- server mismatches: ${report.serverMismatches ?? "not-read"}`,
    "",
    "## Outcome bands",
    "",
    ...report.outcomes.map((entry) => (
      `- ${entry.outcome}: win=${entry.roundWin}, expected=${entry.amount}, ways=${entry.lineWays}, source=${entry.source}, config=${entry.historyConfigId}/${entry.activeConfigId}, formula=${entry.formulaMatches}`
    )),
    "",
    "## Buy probabilities",
    "",
    ...report.buyCases.map((entry) => (
      `- scatter ${entry.scatterCount}: actual=${entry.actualScatterCount}, free=${entry.actualFreeCount}, config=${entry.historyConfigId}/${entry.activeConfigId}, reels=${entry.reelWeightsMatch}, buffers=${entry.buffersMatch}`
    )),
    ""
  ].join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const diagnostics = { console: [], httpErrors: [], requestFailures: [], pageErrors: [], clientCloses: [] };
  const frames = [];
  frames.listeners = [];
  const report = { verdict: "FAIL", baseUrl: args.baseUrl, diagnostics, outcomes: [], buyCases: [] };
  const original = await api(args.baseUrl, "/api/admin/config/active");
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  let live = null;
  try {
    const token = "deep-probability";
    live = await openGame(
      context,
      new URL(`/__game/live?token=${token}`, args.baseUrl).toString(),
      diagnostics,
      frames
    );
    report.outcomes = await verifyOutcomeBands({
      opened: live,
      baseUrl: args.baseUrl,
      out: args.out,
      frames,
      originalPayload: original.payload,
      token
    });
    await closeGame(live);
    live = null;
    await activateConfig(args.baseUrl, "deep-restore-before-admin", original.payload);
    const admin = await configureBuyThroughAdmin({
      browser,
      baseUrl: args.baseUrl,
      out: args.out,
      diagnostics
    });
    report.adminActivatedConfigId = admin.active.id;
    report.buyCases = await verifyBuyCases({
      context,
      baseUrl: args.baseUrl,
      out: args.out,
      diagnostics,
      frames,
      uiActive: admin.active,
      expectedByReel: admin.expectedByReel,
      expectedBuffers: admin.expectedBuffers
    });
    const server = await fetch(new URL("/__history.json", args.baseUrl)).then((response) => response.json());
    report.serverMismatches = server.counts.mismatches;
    const outcomePass = report.outcomes.length === 4 && report.outcomes.every((entry) => (
      entry.roundWin === entry.amount
      && entry.historyOutcome === entry.outcome
      && entry.source === "weighted"
      && entry.historyConfigId === entry.activeConfigId
      && entry.lineCount === 1
      && entry.lineWays === 100
      && entry.forcedColumns
      && entry.formulaMatches
      && entry.terminalLines === 0
      && entry.terminalRoundWin === 0
    ));
    const buyPass = report.buyCases.length === 4 && report.buyCases.every((entry) => (
      entry.actualScatterCount === entry.scatterCount
      && entry.actualFreeCount === entry.expectedFreeCount
      && entry.historyConfigId === entry.activeConfigId
      && entry.reelWeightsMatch
      && entry.buffersMatch
    ));
    const timeout = diagnostics.console.some((line) => /loginAuthFail|auth timeout/i.test(line));
    report.verdict = outcomePass && buyPass
      && !timeout
      && diagnostics.httpErrors.length === 0
      && diagnostics.requestFailures.length === 0
      && diagnostics.pageErrors.length === 0
      && diagnostics.clientCloses.length === 0
      && report.serverMismatches === 0
      ? "PASS"
      : "FAIL";
  } catch (error) {
    report.error = error.stack || error.message;
  } finally {
    if (live) await closeGame(live);
    try {
      await activateConfig(args.baseUrl, `deep-final-restore-${original.name}`, original.payload);
    } catch (error) {
      report.restoreError = error.stack || error.message;
    }
    await context.close();
    await browser.close();
    await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(args.out, "report.md"), markdown(report));
    await writeFile(path.join(args.out, "console.log"), `${diagnostics.console.join("\n")}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== "PASS") process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
