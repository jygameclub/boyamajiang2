#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";
import {
  clickSequenceUntilObservedFrame,
  clickUntilObservedFrame,
  collectRotateSequence,
  decodeObservedFrame,
  renderControlledReport,
  waitForGameCanvas,
  waitForObservedFrame as waitForFrame
} from "./boya-observed-frame.mjs";

const BASE_HIGHLIGHT_DELAY_MS = 2600;
const LIVE_STABILITY_SPINS = 10;

function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18082", out: "", heartbeatWaitMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") args.baseUrl = argv[++index];
    else if (argv[index] === "--out") args.out = argv[++index];
    else if (argv[index] === "--heartbeat-wait-ms") args.heartbeatWaitMs = Number(argv[++index]);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

function bindPage(page, diagnostics, frames) {
  let active = true;
  page.on("console", (message) => diagnostics.console.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
  });
  page.on("websocket", (ws) => {
    ws.on("framesent", (event) => {
      const frame = decodeObservedFrame("send", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    ws.on("framereceived", (event) => {
      const frame = decodeObservedFrame("receive", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    ws.on("close", () => {
      if (active) diagnostics.clientCloses.push(ws.url());
    });
  });
  return () => { active = false; };
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

function publicLine(line) {
  return {
    iconId: line.iconId,
    axleId: line.axleId,
    lineNum: line.lineNum,
    score: line.score,
    multi: line.multi,
    odds: line.odds
  };
}

function validateRotate(rotate, mode, cascadeIndex) {
  const multiplier = rotate.gameNum || rotate.lines[0]?.multi || (mode === "free" ? 2 : 1);
  const calculated = calculateWays(rotate.drawResult, {
    betMulti: rotate.betMulti || 20,
    multiplier,
    mode,
    cascadeIndex
  });
  const actualLines = rotate.lines.map(publicLine).sort((a, b) => a.iconId - b.iconId);
  const expectedLines = calculated.lines.map(publicLine).sort((a, b) => a.iconId - b.iconId);
  return {
    formulaMatches: JSON.stringify(actualLines) === JSON.stringify(expectedLines)
      && rotate.roundWin === calculated.roundWin,
    lineSum: rotate.lines.reduce((sum, line) => sum + line.score, 0),
    expectedRoundWin: calculated.roundWin
  };
}

async function openGame(context, url, diagnostics, frames, screenshotPath) {
  const page = await context.newPage();
  const deactivate = bindPage(page, diagnostics, frames);
  const start = frames.length;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForGameCanvas(page);
  await waitForFrame(frames, (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40001, 90000, "40001");
  await page.waitForTimeout(2500);
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(2200);
  return { page, deactivate };
}

async function verifyBaseLadder({ context, baseUrl, out, diagnostics, frames }) {
  await api(baseUrl, "/api/admin/test-state", {
    method: "PUT",
    body: JSON.stringify({ suiteKey: "base-small-ladder", scenarioKey: null, cursor: 0, cycle: true })
  });
  const { page, deactivate } = await openGame(
    context,
    new URL("/__game/test", baseUrl).toString(),
    diagnostics,
    frames,
    path.join(out, "base-enter.png")
  );
  const expected = [100, 200, 300, 500, 600, 800];
  const results = [];
  for (const amount of expected) {
    const start = frames.length;
    const request = await clickUntilObservedFrame({
      page,
      frames,
      predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40002,
      x: 450,
      y: 1315,
      timeoutMs: 30000,
      label: `base request ${amount}`
    });
    const win = await waitForFrame(
      frames,
      (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003 && frame.rotate?.lines?.length,
      45000,
      `base win ${amount}`
    );
    await page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
    await page.screenshot({ path: path.join(out, `base-${String(amount).padStart(5, "0")}-highlight.png`), fullPage: true });
    const settle = await waitForFrame(
      frames,
      (frame) => frame.id > win.id && frame.direction === "receive" && frame.cmd === 40003,
      30000,
      `base settle ${amount}`
    );
    const validation = validateRotate(win.rotate, "base", 0);
    results.push({
      amount,
      roundWin: win.rotate.roundWin,
      lineSum: validation.lineSum,
      formulaMatches: validation.formulaMatches,
      iconId: win.rotate.lines[0].iconId,
      axleId: win.rotate.lines[0].axleId,
      lineNum: win.rotate.lines[0].lineNum,
      sentinelValid: win.rotate.drawResult[0] === 101 && win.rotate.drawResult[20] === 101,
      settleRoundWin: settle.rotate.roundWin,
      settleLines: settle.rotate.lines.length
    });
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(out, "base-after-wait.png"), fullPage: true });
  deactivate();
  await page.close();
  return results;
}

async function verifyBuyFree({ context, baseUrl, out, diagnostics, frames }) {
  await api(baseUrl, "/api/admin/test-state", {
    method: "PUT",
    body: JSON.stringify({ suiteKey: "buyfree-ladder", scenarioKey: "buyfree-scatter4", cursor: 1, cycle: true })
  });
  const { page, deactivate } = await openGame(context, new URL("/__game/test", baseUrl).toString(), diagnostics, frames);
  await page.mouse.click(145, 1090);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, "buy-dialog.png"), fullPage: true });
  const start = frames.length;
  await page.mouse.click(590, 1150);
  const trigger = await waitForFrame(
    frames,
    (frame) => frame.id > start && frame.direction === "receive" && frame.cmd === 40007,
    45000,
    "40007 buy trigger"
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, "buy-scatter4-entry.png"), fullPage: true });

  const expectedResponses = 25;
  const firstWin = await waitForFrame(
    frames,
    (frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005 && frame.rotate?.lines?.length,
    90000,
    "first free win"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, "buy-first-highlight.png"), fullPage: true });
  const x10 = await waitForFrame(
    frames,
    (frame) => frame.id > firstWin.id && frame.direction === "receive" && frame.cmd === 40005
      && frame.rotate?.lines?.some((line) => line.multi === 10),
    120000,
    "free x10 win"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, "buy-x10-highlight.png"), fullPage: true });
  const largest = await waitForFrame(
    frames,
    (frame) => frame.id > x10.id && frame.direction === "receive" && frame.cmd === 40005
      && frame.rotate?.freeRemainCount === 0
      && frame.rotate?.roundWin === 11280,
    180000,
    "largest free-spin cascade"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, "buy-largest-highlight.png"), fullPage: true });
  const final = await waitForFrame(
    frames,
    (frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005
      && frames.filter((entry) => entry.id > trigger.id && entry.direction === "receive" && entry.cmd === 40005).length >= expectedResponses,
    240000,
    "complete 12 free spins"
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, "buy-free-complete.png"), fullPage: true });
  const freeFrames = frames.filter((frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005).slice(0, expectedResponses);
  const winningFrames = freeFrames.filter((frame) => frame.rotate?.lines?.length);
  const freeSpinGroups = [];
  for (const frame of freeFrames) {
    const remain = Number(frame.rotate.freeRemainCount || 0);
    if (!freeSpinGroups.length || freeSpinGroups.at(-1).remain !== remain) {
      freeSpinGroups.push({ remain, frames: [] });
    }
    freeSpinGroups.at(-1).frames.push(frame);
  }
  const freeSpinTotals = freeSpinGroups.map((group) => Number(group.frames.at(-1).rotate.totalWin || 0));
  const formulaMatches = winningFrames.every((frame) => {
    const lineSum = frame.rotate.lines.reduce((sum, line) => sum + line.score, 0);
    return lineSum === frame.rotate.roundWin
      && frame.rotate.lines.every((line) => line.score === line.odds * line.lineNum * line.multi * (frame.rotate.betMulti || 20));
  });
  const result = {
    scatterCount: trigger.rotate.drawResult.filter((symbol) => symbol === 1).length,
    freeAppend: trigger.rotate.freeAppend,
    freeRemainCount: trigger.rotate.freeRemainCount,
    responseCount: freeFrames.length,
    finalFreeRemain: final.rotate.freeRemainCount,
    winningFrameCount: winningFrames.length,
    largestRoundWin: largest.rotate.roundWin,
    formulaMatches,
    freeSpinTotals,
    ascendingSpinTotals: freeSpinTotals.every((total, index) => index === 0 || total >= freeSpinTotals[index - 1]),
    multipliers: [...new Set(winningFrames.flatMap((frame) => frame.rotate.lines.map((line) => line.multi)))],
    goldToWildFrames: freeFrames.filter((frame) => frame.rotate?.goldToWildPos?.length).length
  };
  deactivate();
  await page.close();
  result.countCases = [{ scatterCount: 4, freeCount: result.freeAppend }];
  for (const scatterCount of [3, 5, 6]) {
    await api(baseUrl, "/api/admin/test-state", {
      method: "PUT",
      body: JSON.stringify({
        suiteKey: "buyfree-ladder",
        scenarioKey: `buyfree-scatter${scatterCount}`,
        cursor: scatterCount - 3,
        cycle: true
      })
    });
    const opened = await openGame(context, new URL("/__game/test", baseUrl).toString(), diagnostics, frames);
    await opened.page.mouse.click(145, 1090);
    await opened.page.waitForTimeout(1200);
    const countStart = frames.length;
    await opened.page.mouse.click(590, 1150);
    const countTrigger = await waitForFrame(
      frames,
      (frame) => frame.id > countStart && frame.direction === "receive" && frame.cmd === 40007,
      45000,
      `scatter ${scatterCount} buy trigger`
    );
    await opened.page.waitForTimeout(1200);
    await opened.page.screenshot({ path: path.join(out, `buy-scatter${scatterCount}-entry.png`), fullPage: true });
    result.countCases.push({
      scatterCount: countTrigger.rotate.drawResult.filter((symbol) => symbol === 1).length,
      freeCount: countTrigger.rotate.freeRemainCount
    });
    await closeGame(opened.page, opened.deactivate);
  }
  return result;
}

async function openFixedRoute({ context, baseUrl, diagnostics, frames, scenarioKey }) {
  await api(baseUrl, "/api/admin/test-state", {
    method: "PUT",
    body: JSON.stringify({ suiteKey: "route-and-cascade", scenarioKey, cursor: 0, cycle: true })
  });
  const opened = await openGame(context, new URL("/__game/test", baseUrl).toString(), diagnostics, frames);
  const start = frames.length;
  const request = await clickUntilObservedFrame({
    page: opened.page,
    frames,
    predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40002,
    x: 450,
    y: 1315,
    timeoutMs: 30000,
    label: `${scenarioKey} request`
  });
  const first = await waitForFrame(
    frames,
    (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003,
    45000,
    `${scenarioKey} first response`
  );
  return { ...opened, first };
}

async function closeGame(page, deactivate) {
  deactivate();
  await page.close();
}

async function verifyRoutes({ context, baseUrl, out, diagnostics, frames }) {
  const gold = await openFixedRoute({
    context,
    baseUrl,
    diagnostics,
    frames,
    scenarioKey: "cascade-gold-to-wild"
  });
  await gold.page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
  await gold.page.screenshot({ path: path.join(out, "route-gold-highlight.png"), fullPage: true });
  const wildStep = await waitForFrame(
    frames,
    (frame) => frame.id > gold.first.id && frame.direction === "receive" && frame.cmd === 40003 && frame.rotate?.lines?.length,
    45000,
    "gold-to-Wild next win"
  );
  await gold.page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
  await gold.page.screenshot({ path: path.join(out, "route-wild-highlight.png"), fullPage: true });
  const goldTerminal = await waitForFrame(
    frames,
    (frame) => frame.id > wildStep.id && frame.direction === "receive" && frame.cmd === 40003 && !frame.rotate?.lines?.length,
    45000,
    "gold-to-Wild terminal"
  );
  const wildEvaluation = calculateWays(wildStep.rotate.drawResult, {
    betMulti: wildStep.rotate.betMulti || 20,
    multiplier: wildStep.rotate.gameNum,
    mode: "base",
    cascadeIndex: 1
  });
  await closeGame(gold.page, gold.deactivate);

  const reuse = await openFixedRoute({
    context,
    baseUrl,
    diagnostics,
    frames,
    scenarioKey: "route-wild-reuse"
  });
  await reuse.page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
  await reuse.page.screenshot({ path: path.join(out, "route-wild-reuse-highlight.png"), fullPage: true });
  const reuseTerminal = await waitForFrame(
    frames,
    (frame) => frame.id > reuse.first.id && frame.direction === "receive" && frame.cmd === 40003 && !frame.rotate?.lines?.length,
    45000,
    "Wild reuse terminal"
  );
  await closeGame(reuse.page, reuse.deactivate);

  const cascade = await openFixedRoute({
    context,
    baseUrl,
    diagnostics,
    frames,
    scenarioKey: "cascade-four-win-steps"
  });
  const cascadeFrames = [cascade.first];
  let current = cascade.first;
  while (current.rotate.lines.length) {
    if (current.rotate.gameNum === 5) {
      await cascade.page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
      await cascade.page.screenshot({ path: path.join(out, "route-cascade-x5-highlight.png"), fullPage: true });
    }
    current = await waitForFrame(
      frames,
      (frame) => frame.id > current.id && frame.direction === "receive" && frame.cmd === 40003,
      45000,
      "four-step cascade"
    );
    cascadeFrames.push(current);
  }
  await closeGame(cascade.page, cascade.deactivate);

  const allFrames = [gold.first, wildStep, goldTerminal, reuse.first, reuseTerminal, ...cascadeFrames];
  return {
    goldToWildCount: gold.first.rotate.goldToWildPos.length,
    wildNextLineCount: wildStep.rotate.lines.length,
    wildEliminatedNext: wildEvaluation.eliminationPositions.some((index) => wildStep.rotate.drawResult[index] === 2),
    goldTerminalWin: goldTerminal.rotate.roundWin,
    reuseLineCount: reuse.first.rotate.lines.length,
    reuseContainsWild: reuse.first.rotate.drawResult.includes(2),
    reuseTerminalWin: reuseTerminal.rotate.roundWin,
    cascadeMultipliers: cascadeFrames.filter((frame) => frame.rotate.lines.length).map((frame) => frame.rotate.gameNum),
    cascadeTerminalWin: cascadeFrames.at(-1).rotate.roundWin,
    formulaMatches: allFrames.every((frame) => validateRotate(frame.rotate, "base", 0).formulaMatches)
  };
}

async function verifyLive({ context, baseUrl, out, diagnostics, frames }) {
  const original = await api(baseUrl, "/api/admin/config/active");
  const forced = structuredClone(original.payload);
  forced.modes.base.outcomeWeights = { miss: 0, small: 0, medium: 1, big: 0, mega: 0, super: 0 };
  forced.modes.base.scatterCap = 0;
  forced.modes.base.initial.goldRateByReel = [0, 0, 0, 0, 0];
  forced.modes.base.initial.symbolWeights = [19, 19, 19, 3, 5].map((symbol) => ({ [symbol]: 1 }));
  forced.modes.base.cascade.goldRateByReel = [0, 0, 0, 0, 0];
  forced.modes.base.cascade.symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  forced.modes.buy.scatterWeights = { scatter3: 1, scatter4: 0, scatter5: 0, scatter6plus: 0 };
  forced.modes.free.outcomeWeights = { miss: 1, small: 0, medium: 0, big: 0, mega: 0, super: 0 };
  forced.modes.free.scatterCap = 0;
  for (const phase of ["initial", "cascade"]) {
    forced.modes.free[phase].goldRateByReel = [0, 0, 100, 0, 0];
    forced.modes.free[phase].symbolWeights = [3, 5, 7, 9, 11].map((symbol) => ({ [symbol]: 1 }));
  }
  const draft = await api(baseUrl, "/api/admin/config/drafts", {
    method: "POST",
    body: JSON.stringify({ name: "playwright-forced-medium", payload: forced })
  });
  const active = await api(baseUrl, `/api/admin/config/drafts/${draft.id}/activate`, { method: "POST" });
  let opened = null;
  const results = [];
  let liveFree = null;
  try {
    opened = await openGame(context, new URL("/__game/live", baseUrl).toString(), diagnostics, frames);
    for (let spin = 0; spin < LIVE_STABILITY_SPINS; spin += 1) {
      const start = frames.length;
      const request = await clickUntilObservedFrame({
        page: opened.page,
        frames,
        predicate: (frame) => frame.id > start && frame.direction === "send" && frame.cmd === 40002,
        x: 450,
        y: 1315,
        timeoutMs: 30000,
        label: `live request ${spin + 1}`
      });
      const first = await waitForFrame(
        frames,
        (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003,
        45000,
        `live spin ${spin + 1}`
      );
      if (spin === 0) {
        await opened.page.waitForTimeout(BASE_HIGHLIGHT_DELAY_MS);
        await opened.page.screenshot({ path: path.join(out, "live-forced-medium-highlight.png"), fullPage: true });
      }
      const sequence = await collectRotateSequence({
        frames,
        firstFrame: first,
        responseCmd: 40003,
        timeoutMs: 45000,
        label: `live settle ${spin + 1}`
      });
      const terminal = sequence.at(-1);
      const validations = sequence.map((frame, cascadeIndex) => validateRotate(frame.rotate, "base", cascadeIndex));
      await opened.page.waitForTimeout(900);
      const idleRequests = frames.filter((frame) => (
        frame.id > terminal.id && frame.direction === "send" && frame.cmd === 40002
      )).length;
      results.push({
        spin: spin + 1,
        configId: active.id,
        roundWin: first.rotate.roundWin,
        lineCount: first.rotate.lines.length,
        lineSum: validations[0].lineSum,
        formulaMatches: validations.every((validation) => validation.formulaMatches),
        responseCount: sequence.length,
        totalWin: terminal.rotate.totalWin,
        terminalRoundWin: terminal.rotate.roundWin,
        terminalLines: terminal.rotate.lines.length,
        idleRequests,
        sentinelValid: first.rotate.drawResult[0] === 101 && first.rotate.drawResult[20] === 101
      });
    }
    await opened.page.screenshot({ path: path.join(out, "live-after-spins.png"), fullPage: true });
    const buyStart = frames.length;
    const buyRequest = await clickSequenceUntilObservedFrame({
      page: opened.page,
      frames,
      predicate: (frame) => frame.id > buyStart && frame.direction === "send" && frame.cmd === 40006,
      clicks: [{ x: 145, y: 1090 }, { x: 590, y: 1150 }],
      clickDelayMs: 900,
      timeoutMs: 30000,
      label: "live weighted-free buy request"
    });
    const trigger = await waitForFrame(
      frames,
      (frame) => frame.id > buyRequest.id && frame.direction === "receive" && frame.cmd === 40007,
      45000,
      "live weighted-free trigger"
    );
    await opened.page.waitForTimeout(3000);
    await opened.page.screenshot({ path: path.join(out, "live-free-entry.png"), fullPage: true });
    const finalFree = await waitForFrame(
      frames,
      (frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005
        && frames.filter((entry) => entry.id > trigger.id && entry.direction === "receive" && entry.cmd === 40005).length >= 10,
      180000,
      "ten weighted free spins"
    );
    const generatedFreeFrames = frames
      .filter((frame) => frame.id > trigger.id && frame.direction === "receive" && frame.cmd === 40005)
      .slice(0, 10);
    await opened.page.waitForTimeout(1200);
    await opened.page.screenshot({ path: path.join(out, "live-free-complete.png"), fullPage: true });
    const recent = await api(baseUrl, `/api/history/rounds?mode=live&limit=${LIVE_STABILITY_SPINS + 5}`);
    const baseRounds = recent.filter((round) => round.kind === "base").slice(0, LIVE_STABILITY_SPINS);
    results.forEach((entry, index) => { entry.historySource = baseRounds[index]?.source || null; });
    const freeHistory = recent.find((round) => round.kind === "free-feature");
    liveFree = {
      scatterCount: trigger.rotate.drawResult.filter((symbol) => symbol === 1).length,
      freeCount: trigger.rotate.freeRemainCount,
      responseCount: generatedFreeFrames.length,
      finalFreeRemain: finalFree.rotate.freeRemainCount,
      historySource: freeHistory?.source || null,
      formulaMatches: generatedFreeFrames.every((frame) => validateRotate(frame.rotate, "free", 0).formulaMatches),
      configuredColumnsMatch: generatedFreeFrames.every((frame) => (
        frame.rotate.drawResult[1] === 3
        && frame.rotate.drawResult[5] === 5
        && frame.rotate.drawResult[10] === 8
        && frame.rotate.drawResult[15] === 9
        && frame.rotate.drawResult[21] === 11
      ))
    };
  } finally {
    if (opened) await closeGame(opened.page, opened.deactivate);
    const restoreDraft = await api(baseUrl, "/api/admin/config/drafts", {
      method: "POST",
      body: JSON.stringify({ name: `restore-${original.name}`, payload: original.payload })
    });
    await api(baseUrl, `/api/admin/config/drafts/${restoreDraft.id}/activate`, { method: "POST" });
  }
  return { spins: results, free: liveFree };
}

async function verifyAdmin({ browser, baseUrl, out, diagnostics }) {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktop = await desktopContext.newPage();
  desktop.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  desktop.on("response", (response) => {
    if (response.status() >= 400) diagnostics.httpErrors.push({ status: response.status(), url: response.url() });
  });
  await desktop.goto(new URL("/__admin", baseUrl).toString(), { waitUntil: "networkidle" });
  await desktop.screenshot({ path: path.join(out, "admin-desktop.png"), fullPage: true });
  await desktop.locator('.tab[data-tab="history"]').click();
  await desktop.waitForTimeout(500);
  await desktop.screenshot({ path: path.join(out, "admin-history.png"), fullPage: true });
  const desktopResult = {
    weightRows: await desktop.locator("#weight-rows tr").count(),
    historyRows: await desktop.locator("#history-rows tr").count(),
    configVersion: await desktop.locator("#config-version").textContent()
  };
  await desktopContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await mobileContext.newPage();
  mobile.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  await mobile.goto(new URL("/__admin", baseUrl).toString(), { waitUntil: "networkidle" });
  await mobile.screenshot({ path: path.join(out, "admin-mobile.png"), fullPage: true });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await mobileContext.close();
  return { ...desktopResult, mobileOverflow };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const diagnostics = { console: [], pageErrors: [], httpErrors: [], clientCloses: [] };
  const frames = [];
  frames.listeners = [];
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  const report = {
    verdict: "FAIL",
    baseUrl: args.baseUrl,
    baseLadder: [],
    routes: null,
    buyFree: null,
    live: [],
    liveFree: null,
    admin: null,
    serverMismatches: null
  };
  try {
    report.baseLadder = await verifyBaseLadder({ context, baseUrl: args.baseUrl, out: args.out, diagnostics, frames });
    report.routes = await verifyRoutes({ context, baseUrl: args.baseUrl, out: args.out, diagnostics, frames });
    report.buyFree = await verifyBuyFree({ context, baseUrl: args.baseUrl, out: args.out, diagnostics, frames });
    const liveVerification = await verifyLive({ context, baseUrl: args.baseUrl, out: args.out, diagnostics, frames });
    report.live = liveVerification.spins;
    report.liveFree = liveVerification.free;
    report.admin = await verifyAdmin({ browser, baseUrl: args.baseUrl, out: args.out, diagnostics });
    await new Promise((resolve) => setTimeout(resolve, args.heartbeatWaitMs));
    const history = await fetch(new URL("/__history.json", args.baseUrl)).then((response) => response.json());
    report.serverMismatches = history.counts.mismatches;
    report.persistedRounds = history.rounds.length;
    const basePass = report.baseLadder.length === 6 && report.baseLadder.every((entry) => (
      entry.roundWin === entry.amount
      && entry.lineSum === entry.amount
      && entry.formulaMatches
      && entry.sentinelValid
      && entry.settleRoundWin === 0
      && entry.settleLines === 0
    ));
    const buyPass = report.buyFree.scatterCount === 4
      && report.buyFree.freeAppend === 12
      && report.buyFree.freeRemainCount === 12
      && report.buyFree.responseCount === 25
      && report.buyFree.finalFreeRemain === 0
      && report.buyFree.largestRoundWin === 11280
      && report.buyFree.formulaMatches
      && report.buyFree.ascendingSpinTotals
      && JSON.stringify(report.buyFree.freeSpinTotals.slice(-4)) === JSON.stringify([560, 1280, 5360, 14560])
      && [2, 4, 6, 10].every((multi) => report.buyFree.multipliers.includes(multi))
      && report.buyFree.goldToWildFrames > 0
      && JSON.stringify([...report.buyFree.countCases].sort((a, b) => a.scatterCount - b.scatterCount))
        === JSON.stringify([
          { scatterCount: 3, freeCount: 10 },
          { scatterCount: 4, freeCount: 12 },
          { scatterCount: 5, freeCount: 14 },
          { scatterCount: 6, freeCount: 15 }
        ]);
    const routePass = report.routes.goldToWildCount > 0
      && report.routes.wildNextLineCount > 0
      && report.routes.wildEliminatedNext
      && report.routes.goldTerminalWin === 0
      && report.routes.reuseLineCount === 2
      && report.routes.reuseContainsWild
      && report.routes.reuseTerminalWin === 0
      && JSON.stringify(report.routes.cascadeMultipliers) === JSON.stringify([1, 2, 3, 5])
      && report.routes.cascadeTerminalWin === 0
      && report.routes.formulaMatches;
    const livePass = report.live.length === LIVE_STABILITY_SPINS && report.live.every((entry) => (
      entry.formulaMatches
      && entry.sentinelValid
      && entry.roundWin === 2000
      && entry.lineSum === 2000
      && entry.totalWin === 2000
      && entry.historySource === "weighted"
      && entry.terminalRoundWin === 0
      && entry.terminalLines === 0
      && entry.idleRequests === 0
    ))
      && report.liveFree.scatterCount === 3
      && report.liveFree.freeCount === 10
      && report.liveFree.responseCount === 10
      && report.liveFree.finalFreeRemain === 0
      && report.liveFree.historySource === "weighted-free"
      && report.liveFree.formulaMatches
      && report.liveFree.configuredColumnsMatch;
    const adminPass = report.admin.weightRows === 10 && report.admin.historyRows > 0 && !report.admin.mobileOverflow;
    const timeoutText = diagnostics.console.some((line) => /登录超时|登录认证超时|loginAuthFail/i.test(line));
    report.verdict = basePass && routePass && buyPass && livePass && adminPass
      && !timeoutText
      && !diagnostics.httpErrors.length
      && !diagnostics.pageErrors.length
      && !diagnostics.clientCloses.length
      && report.serverMismatches === 0
      ? "PASS"
      : "FAIL";
  } catch (error) {
    report.error = error?.stack || String(error);
  } finally {
    report.diagnostics = diagnostics;
    report.counts = {
      send40002: frames.filter((frame) => frame.direction === "send" && frame.cmd === 40002).length,
      receive40003: frames.filter((frame) => frame.direction === "receive" && frame.cmd === 40003).length,
      send40006: frames.filter((frame) => frame.direction === "send" && frame.cmd === 40006).length,
      receive40007: frames.filter((frame) => frame.direction === "receive" && frame.cmd === 40007).length,
      send40004: frames.filter((frame) => frame.direction === "send" && frame.cmd === 40004).length,
      receive40005: frames.filter((frame) => frame.direction === "receive" && frame.cmd === 40005).length
    };
    await writeFile(path.join(args.out, "network.json"), `${JSON.stringify({ ...report, frames }, null, 2)}\n`, "utf8");
    await writeFile(path.join(args.out, "console.log"), `${diagnostics.console.join("\n")}\n`, "utf8");
    await writeFile(path.join(args.out, "report.md"), renderControlledReport(report), "utf8");
    await context.close();
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
    if (report.verdict !== "PASS") process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
