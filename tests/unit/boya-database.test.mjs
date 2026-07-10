import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openLocalStore } from "../../tools/local/server/database.mjs";

test("SQLite store persists active config, test state, rounds, and steps", async (context) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "boya-db-"));
  context.after(() => rm(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, "boya.sqlite3");

  let store = openLocalStore(dbPath);
  const initial = store.getActiveConfig();
  assert.equal(initial.status, "active");
  assert.equal(initial.payload.buyCostMultiplier, 80);

  const payload = structuredClone(initial.payload);
  payload.modes.base.initial.symbolWeights[0][19] = 999;
  const draft = store.createDraft("forced-live", payload);
  assert.equal(draft.status, "draft");
  const activated = store.activateConfig(draft.id);
  assert.equal(activated.status, "active");
  assert.equal(store.getActiveConfig().payload.modes.base.initial.symbolWeights[0][19], 999);

  store.updateTestState({ suiteKey: "base-small-ladder", scenarioKey: "base-small-300", cursor: 2, cycle: true });
  const session = store.createSession({ mode: "test", seed: "seed-1", configId: activated.id });
  const round = store.recordRound({
    sessionId: session.id,
    roundNo: 1,
    kind: "base",
    bet: 400,
    totalWin: 300,
    outcome: "small",
    source: "scenario",
    scenarioKey: "base-small-300",
    seed: "seed-1",
    validationStatus: "ok",
    steps: [{
      stepNo: 0,
      cmd: 40003,
      board: [101, ...Array(19).fill(3), 101, 3, 3, 3, 3],
      topResult: [3, 5, 7, 9, 11],
      buttomResult: [3, 5, 7, 9, 11],
      lines: [{ iconId: 13, score: 300 }],
      multiplier: 1,
      roundWin: 300,
      totalWin: 300,
      freeRemain: 0,
      goldToWild: []
    }]
  });
  assert.ok(round.id > 0);
  store.close();

  store = openLocalStore(dbPath);
  assert.equal(store.getTestState().scenarioKey, "base-small-300");
  assert.equal(store.getActiveConfig().name, "forced-live");
  const rounds = store.listRounds({ limit: 10 });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].totalWin, 300);
  assert.equal(store.getRound(rounds[0].id).steps.length, 1);
  store.close();
});

