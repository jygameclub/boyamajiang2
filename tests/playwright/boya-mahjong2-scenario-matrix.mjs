#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  WILD_SYMBOL,
  baseSymbolFor,
  boardIndex,
  playableRowsForReel
} from "../../tools/local/engine/constants.mjs";
import { calculateWays } from "../../tools/local/engine/ways-calculator.mjs";
import {
  clickUntilObservedFrame,
  decodeObservedFrame,
  waitForGameCanvas,
  waitForObservedFrame as waitForFrame
} from "./boya-observed-frame.mjs";

const BASE_HIGHLIGHT_DELAYS_MS = [1800, 500, 500];
const CASCADE_HIGHLIGHT_DELAYS_MS = [700, 500, 500];
const SCATTER_HIGHLIGHT_DELAYS_MS = [9800, 800, 600];

function parseArgs(argv) {
  const args = { baseUrl: "http://127.0.0.1:18082", out: "", limit: 0, scenario: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") args.baseUrl = argv[++index];
    else if (argv[index] === "--out") args.out = argv[++index];
    else if (argv[index] === "--limit") args.limit = Number(argv[++index]);
    else if (argv[index] === "--scenario") args.scenario = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!args.out) throw new Error("--out is required");
  return args;
}

async function api(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined
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
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      const frame = decodeObservedFrame("send", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    socket.on("framereceived", (event) => {
      const frame = decodeObservedFrame("receive", event.payload, frames.length + 1);
      if (frame) {
        frames.push(frame);
        frames.listeners.forEach((listener) => listener(frame));
      }
    });
    socket.on("close", () => {
      if (active) diagnostics.clientCloses.push(socket.url());
    });
  });
  return () => { active = false; };
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

function positionsByReel(board, line) {
  return Array.from({ length: line.axleId + 1 }, (_, reel) => (
    playableRowsForReel(reel)
      .map((row) => boardIndex(reel, row))
      .filter((index) => board[index] === WILD_SYMBOL || baseSymbolFor(board[index]) === line.iconId)
  ));
}

function inspectRotate(rotate, cascadeIndex) {
  const calculated = calculateWays(rotate.drawResult, {
    betMulti: rotate.betMulti,
    multiplier: rotate.gameNum,
    mode: "base",
    cascadeIndex
  });
  const actualLines = rotate.lines.map(publicLine).sort((left, right) => left.iconId - right.iconId);
  const expectedLines = calculated.lines.map(publicLine).sort((left, right) => left.iconId - right.iconId);
  const paths = actualLines.map((line) => ({
    iconId: line.iconId,
    positionsByReel: positionsByReel(rotate.drawResult, line)
  }));
  return {
    formulaMatches: JSON.stringify(actualLines) === JSON.stringify(expectedLines)
      && rotate.roundWin === calculated.roundWin
      && rotate.roundWin === actualLines.reduce((sum, line) => sum + line.score, 0),
    pathsValid: paths.every((path) => path.positionsByReel.length >= 3
      && path.positionsByReel.every((positions) => positions.length > 0)),
    actualLines,
    expectedLines,
    paths
  };
}

function renderReport(report) {
  return `${[
    "# Boya Mahjong2 deterministic scenario matrix",
    "",
    `- verdict: ${report.verdict}`,
    `- scenarios: ${report.scenarios.length}`,
    `- HTTP >= 400: ${report.diagnostics.httpErrors.length}`,
    `- pageErrors: ${report.diagnostics.pageErrors.length}`,
    `- clientCloses: ${report.diagnostics.clientCloses.length}`,
    `- authTimeout: ${report.authTimeout}`,
    `- serverMismatches: ${report.serverMismatches}`,
    "",
    ...report.scenarios.map((scenario) => (
      `- ${scenario.key}: ${scenario.verdict}, winSteps=${scenario.winSteps}, multipliers=${scenario.multipliers.join("/") || "-"}, lines=${scenario.lineCounts.join("/")}`
    )),
    ""
  ].join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const diagnostics = { console: [], pageErrors: [], httpErrors: [], clientCloses: [] };
const frames = [];
frames.listeners = [];
const report = { baseUrl: args.baseUrl, diagnostics, scenarios: [], verdict: "FAIL" };
let browser;
let context;
let deactivate = () => {};

try {
  const catalog = await api(args.baseUrl, "/api/admin/scenarios");
  const routeSuite = catalog.suites.find((suite) => suite.key === "route-and-cascade");
  const selectedScenarios = args.scenario
    ? routeSuite.scenarios.filter((scenario) => scenario.key === args.scenario)
    : routeSuite.scenarios;
  if (args.scenario && !selectedScenarios.length) throw new Error(`Unknown scenario ${args.scenario}`);
  const scenarios = args.limit > 0 ? selectedScenarios.slice(0, args.limit) : selectedScenarios;
  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  context = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  const page = await context.newPage();
  deactivate = bindPage(page, diagnostics, frames);
  const openStart = frames.length;
  await page.goto(new URL("/__game/test", args.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await waitForGameCanvas(page);
  await waitForFrame(
    frames,
    (frame) => frame.id > openStart && frame.direction === "receive" && frame.cmd === 40001,
    90000,
    "test 40001"
  );
  await page.waitForTimeout(2500);
  await page.mouse.click(450, 1075);
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(args.out, "test-enter.png") });

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    await api(args.baseUrl, "/api/admin/test-state", {
      method: "PUT",
      body: JSON.stringify({
        suiteKey: "route-and-cascade",
        scenarioKey: scenario.key,
        cursor: scenarioIndex,
        cycle: true
      })
    });
    const scenarioOut = path.join(args.out, `${String(scenarioIndex + 1).padStart(2, "0")}-${scenario.key}`);
    await mkdir(scenarioOut, { recursive: true });
    const requestStart = frames.length;
    const request = await clickUntilObservedFrame({
      page,
      frames,
      predicate: (frame) => frame.id > requestStart && frame.direction === "send" && frame.cmd === 40002,
      x: 450,
      y: 1315,
      timeoutMs: 45000,
      label: `${scenario.key} 40002`
    });
    let current = await waitForFrame(
      frames,
      (frame) => frame.id > request.id && frame.direction === "receive" && frame.cmd === 40003,
      45000,
      `${scenario.key} first 40003`
    );
    const steps = [];
    let terminalFrameId = 0;
    for (let stepIndex = 0; stepIndex < 12; stepIndex += 1) {
      const inspection = inspectRotate(current.rotate, stepIndex);
      const step = {
        stepIndex,
        drawResult: current.rotate.drawResult,
        topResult: current.rotate.topResult,
        buttomResult: current.rotate.buttomResult,
        lines: current.rotate.lines.map(publicLine),
        roundWin: current.rotate.roundWin,
        totalWin: current.rotate.totalWin,
        gameNum: current.rotate.gameNum,
        goldToWildPos: current.rotate.goldToWildPos,
        wildCount: current.rotate.drawResult.filter((symbol) => symbol === WILD_SYMBOL).length,
        scatterCount: current.rotate.drawResult.filter((symbol) => symbol === 1).length,
        ...inspection
      };
      steps.push(step);
      if (current.rotate.lines.length) {
        const delays = stepIndex === 0 && step.scatterCount >= 2
          ? SCATTER_HIGHLIGHT_DELAYS_MS
          : stepIndex === 0
            ? BASE_HIGHLIGHT_DELAYS_MS
            : CASCADE_HIGHLIGHT_DELAYS_MS;
        for (let captureIndex = 0; captureIndex < delays.length; captureIndex += 1) {
          await page.waitForTimeout(delays[captureIndex]);
          const suffix = captureIndex === 1 ? "highlight" : `highlight-candidate-${captureIndex + 1}`;
          await page.screenshot({
            path: path.join(scenarioOut, `step-${String(stepIndex + 1).padStart(2, "0")}-${suffix}.png`)
          });
        }
      } else {
        terminalFrameId = current.id;
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(scenarioOut, "terminal.png") });
        break;
      }
      current = await waitForFrame(
        frames,
        (frame) => frame.id > current.id && frame.direction === "receive" && frame.cmd === 40003,
        45000,
        `${scenario.key} cascade ${stepIndex + 2}`
      );
    }
    const winning = steps.filter((step) => step.lines.length);
    const peakWild = Math.max(...steps.map((step) => step.wildCount));
    const hasGoldTransform = steps.some((step) => step.goldToWildPos.length > 0);
    const scatterCounts = steps.map((step) => step.scatterCount);
    await page.waitForTimeout(900);
    const idleRequests = frames.filter((frame) => (
      frame.id > terminalFrameId && frame.direction === "send" && frame.cmd === 40002
    )).length;
    const verdict = steps.every((step) => step.formulaMatches && step.pathsValid)
      && winning.length === scenario.winSteps
      && JSON.stringify(winning.map((step) => step.gameNum)) === JSON.stringify(scenario.multipliers)
      && peakWild >= (scenario.minPeakWild || 0)
      && hasGoldTransform === Boolean(scenario.goldToWild)
      && scatterCounts[0] === (scenario.scatterCount || 0)
      && scatterCounts.every((count) => count <= 2)
      && steps.at(-1).lines.length === 0
      && idleRequests === 0
      ? "PASS"
      : "FAIL";
    const scenarioResult = {
      key: scenario.key,
      label: scenario.label,
      verdict,
      winSteps: winning.length,
      multipliers: winning.map((step) => step.gameNum),
      lineCounts: winning.map((step) => step.lines.length),
      peakWild,
      hasGoldTransform,
      scatterCounts,
      idleRequests,
      steps
    };
    report.scenarios.push(scenarioResult);
    await writeFile(path.join(scenarioOut, "protocol.json"), `${JSON.stringify(scenarioResult, null, 2)}\n`);
    await page.waitForTimeout(500);
  }

  await api(args.baseUrl, "/api/admin/test-state", {
    method: "PUT",
    body: JSON.stringify({ suiteKey: "route-and-cascade", scenarioKey: null, cursor: 0, cycle: true })
  });
  await page.waitForTimeout(5500);
  const replayHistory = await fetch(new URL("/__history.json", args.baseUrl)).then((response) => response.json());
  report.serverMismatches = replayHistory.counts.mismatches;
  report.authTimeout = diagnostics.console.some((line) => /登录超时|登录认证超时|loginAuthFail/i.test(line));
  report.verdict = report.scenarios.length === scenarios.length
    && report.scenarios.every((scenario) => scenario.verdict === "PASS")
    && diagnostics.httpErrors.length === 0
    && diagnostics.pageErrors.length === 0
    && diagnostics.clientCloses.length === 0
    && !report.authTimeout
    && report.serverMismatches === 0
    ? "PASS"
    : "FAIL";
} catch (error) {
  report.error = error.stack || error.message;
} finally {
  deactivate();
  if (context) await context.close();
  if (browser) await browser.close();
  await writeFile(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(args.out, "report.md"), renderReport(report));
  await writeFile(path.join(args.out, "console.log"), `${diagnostics.console.join("\n")}\n`);
}

if (report.verdict !== "PASS") process.exitCode = 1;
