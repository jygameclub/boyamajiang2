import { PAYING_SYMBOLS, SCATTER_SYMBOL } from "../engine/constants.mjs";
import { generateLiveRound } from "../engine/outcome-selector.mjs";
import { createRouteAndCascadeScenarios, createSmallWinScenarios } from "../engine/scenarios.mjs";
import { calculateWays } from "../engine/ways-calculator.mjs";

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("REQUEST_BODY_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
}

export function validateControlConfig(payload) {
  requireObject(payload, "CONFIG_INVALID");
  if (Number(payload.buyCostMultiplier) !== 80) throw new Error("BUY_COST_MULTIPLIER_LOCKED");
  const allowedSymbols = new Set([SCATTER_SYMBOL, ...PAYING_SYMBOLS]);
  for (const mode of ["base", "free", "buy"]) {
    const modeConfig = payload.modes?.[mode];
    requireObject(modeConfig, `MODE_CONFIG_MISSING:${mode}`);
    for (const phase of ["initial", "cascade"]) {
      const phaseConfig = modeConfig[phase];
      if (!Array.isArray(phaseConfig?.symbolWeights) || phaseConfig.symbolWeights.length !== 5) {
        throw new Error(`REEL_WEIGHT_COUNT_INVALID:${mode}:${phase}`);
      }
      if (!Array.isArray(phaseConfig.goldRateByReel) || phaseConfig.goldRateByReel.length !== 5) {
        throw new Error(`GOLD_RATE_COUNT_INVALID:${mode}:${phase}`);
      }
      if (Number(phaseConfig.goldRateByReel[0]) !== 0 || Number(phaseConfig.goldRateByReel[4]) !== 0) {
        throw new Error(`GOLD_EDGE_REEL_INVALID:${mode}:${phase}`);
      }
      phaseConfig.symbolWeights.forEach((weights, reel) => {
        requireObject(weights, `REEL_WEIGHT_INVALID:${mode}:${phase}:${reel}`);
        let positive = 0;
        for (const [symbolText, weightValue] of Object.entries(weights)) {
          const symbol = Number(symbolText);
          const weight = Number(weightValue);
          if (!allowedSymbols.has(symbol) || !Number.isInteger(weight) || weight < 0 || weight > 100000) {
            throw new Error(`SYMBOL_WEIGHT_INVALID:${mode}:${phase}:${reel}:${symbolText}`);
          }
          if (symbol !== SCATTER_SYMBOL) positive += weight;
        }
        if (positive <= 0) throw new Error(`REEL_HAS_NO_PAYING_SYMBOL:${mode}:${phase}:${reel}`);
      });
    }
    if (!Number.isInteger(Number(modeConfig.cascadeLimit))
        || Number(modeConfig.cascadeLimit) < 1
        || Number(modeConfig.cascadeLimit) > 10) {
      throw new Error(`CASCADE_LIMIT_INVALID:${mode}`);
    }
    const outcomeWeights = modeConfig.outcomeWeights || modeConfig.scatterWeights;
    requireObject(outcomeWeights, `OUTCOME_WEIGHTS_MISSING:${mode}`);
    if (!Object.values(outcomeWeights).some((weight) => Number(weight) > 0)) {
      throw new Error(`OUTCOME_WEIGHTS_EMPTY:${mode}`);
    }
  }
  return { ok: true };
}

export function buildScenarioCatalog() {
  return {
    suites: [
      {
        key: "base-small-ladder",
        label: "普通小奖阶梯",
        scenarios: createSmallWinScenarios().map((scenario) => ({
          key: scenario.key,
          amount: scenario.amount,
          iconId: scenario.iconId,
          axleId: scenario.expectedLine.axleId,
          lineNum: scenario.expectedLine.lineNum
        }))
      },
      {
        key: "route-and-cascade",
        label: "线路、级联与 Wild",
        scenarios: createRouteAndCascadeScenarios().map((scenario) => {
          const evaluation = calculateWays(scenario.initialBoard, {
            betMulti: 20,
            multiplier: 1,
            mode: "base"
          });
          const firstLine = evaluation.lines[0];
          return {
            key: scenario.key,
            label: scenario.label,
            tags: scenario.tags,
            winSteps: scenario.expect.winSteps,
            multipliers: scenario.expect.multipliers,
            minPeakWild: scenario.expect.minPeakWild || 0,
            goldToWild: Boolean(scenario.expect.goldToWild),
            scatter: Boolean(scenario.expect.scatter),
            amount: evaluation.roundWin,
            iconId: firstLine?.iconId ?? null,
            axleId: firstLine?.axleId ?? null,
            lineNum: firstLine?.lineNum ?? 0
          };
        })
      },
      {
        key: "buyfree-ladder",
        label: "购买免费胡数量",
        scenarios: [3, 4, 5, 6].map((scatterCount) => ({
          key: `buyfree-scatter${scatterCount}`,
          amount: 0,
          iconId: 1,
          axleId: 0,
          lineNum: scatterCount
        }))
      }
    ]
  };
}

export async function handleControlApi(req, res, { store, state, sendJson }) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/admin/")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/admin/runtime") {
      sendJson(res, {
        ok: true,
        data: {
          startedAt: state.startedAt,
          counts: state.counts,
          stats: store.runtimeStats(),
          activeConfig: store.getActiveConfig(),
          testState: store.getTestState()
        }
      });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      sendJson(res, { ok: true, data: store.listUsers() });
      return true;
    }
    const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && userMatch) {
      const user = store.getUserStats(decodeURIComponent(userMatch[1]));
      if (!user) {
        sendJson(res, { ok: false, error: "USER_NOT_FOUND" }, 404);
      } else {
        sendJson(res, { ok: true, data: user });
      }
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/config/active") {
      sendJson(res, { ok: true, data: store.getActiveConfig() });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/configs") {
      sendJson(res, { ok: true, data: store.listConfigs() });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/config/drafts") {
      const body = await readJsonBody(req);
      validateControlConfig(body.payload);
      sendJson(res, { ok: true, data: store.createDraft(body.name, body.payload) }, 201);
      return true;
    }
    const draftMatch = /^\/api\/admin\/config\/drafts\/(\d+)$/.exec(url.pathname);
    if (req.method === "PUT" && draftMatch) {
      const body = await readJsonBody(req);
      validateControlConfig(body.payload);
      sendJson(res, {
        ok: true,
        data: store.updateDraft(Number(draftMatch[1]), body.payload, body.expectedRevision)
      });
      return true;
    }
    const validateMatch = /^\/api\/admin\/config\/drafts\/(\d+)\/validate$/.exec(url.pathname);
    if (req.method === "POST" && validateMatch) {
      const config = store.getConfig(Number(validateMatch[1]));
      if (!config) throw Object.assign(new Error("CONFIG_NOT_FOUND"), { statusCode: 404 });
      sendJson(res, { ok: true, data: validateControlConfig(config.payload) });
      return true;
    }
    const activateMatch = /^\/api\/admin\/config\/drafts\/(\d+)\/activate$/.exec(url.pathname);
    if (req.method === "POST" && activateMatch) {
      const config = store.getConfig(Number(activateMatch[1]));
      if (!config) throw Object.assign(new Error("CONFIG_NOT_FOUND"), { statusCode: 404 });
      validateControlConfig(config.payload);
      sendJson(res, { ok: true, data: store.activateConfig(config.id) });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/scenarios") {
      sendJson(res, { ok: true, data: buildScenarioCatalog() });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/test-state") {
      sendJson(res, { ok: true, data: store.getTestState() });
      return true;
    }
    if (req.method === "PUT" && url.pathname === "/api/admin/test-state") {
      const body = await readJsonBody(req);
      const catalog = buildScenarioCatalog();
      const suite = catalog.suites.find((entry) => entry.key === body.suiteKey);
      if (!suite) throw new Error("TEST_SUITE_NOT_FOUND");
      if (body.scenarioKey && !suite.scenarios.some((entry) => entry.key === body.scenarioKey)) {
        throw new Error("TEST_SCENARIO_NOT_FOUND");
      }
      sendJson(res, { ok: true, data: store.updateTestState(body) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/simulate") {
      const body = await readJsonBody(req);
      const config = body.config || store.getActiveConfig().payload;
      validateControlConfig(config);
      const count = Math.max(1, Math.min(1000, Number(body.count) || 100));
      const outcomes = {};
      const sources = {};
      let totalWin = 0;
      for (let index = 0; index < count; index += 1) {
        const generated = generateLiveRound({
          config,
          seed: `${body.seed || "admin-sim"}:${index}`,
          betMulti: Number(body.betMulti) || 20,
          betCoin: Number(body.betCoin) || 400,
          mode: "base"
        });
        outcomes[generated.outcome] = (outcomes[generated.outcome] || 0) + 1;
        sources[generated.source] = (sources[generated.source] || 0) + 1;
        totalWin += generated.plan.totalWin;
      }
      sendJson(res, { ok: true, data: { count, outcomes, sources, totalWin } });
      return true;
    }

    sendJson(res, { ok: false, error: "ADMIN_API_NOT_FOUND" }, 404);
    return true;
  } catch (error) {
    sendJson(res, {
      ok: false,
      error: error.message || "ADMIN_API_ERROR"
    }, error.statusCode || (error instanceof SyntaxError ? 400 : 422));
    return true;
  }
}
