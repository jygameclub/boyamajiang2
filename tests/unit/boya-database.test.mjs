import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openLocalStore } from "../../tools/local/server/database.mjs";

test("local users keep isolated balances, history, and RTP totals", () => {
  const store = openLocalStore(":memory:");
  const active = store.getActiveConfig();
  const user1 = store.getOrCreateUser("user1");
  const sameUser = store.getOrCreateUser("user1");
  const user2 = store.getOrCreateUser("user2");

  assert.equal(user1.balance, 100_000_000);
  assert.equal(sameUser.id, user1.id);
  assert.notEqual(user2.id, user1.id);

  const session1 = store.createSession({
    mode: "live",
    seed: "user1-session",
    configId: active.id,
    userId: user1.id
  });
  store.recordRound({
    sessionId: session1.id,
    roundNo: 1,
    kind: "base",
    bet: 400,
    totalWin: 800,
    outcome: "small",
    source: "weighted",
    seed: "user1-base",
    validationStatus: "ok",
    userBalanceAfter: 100_000_400,
    steps: []
  });
  store.recordRound({
    sessionId: session1.id,
    roundNo: 2,
    kind: "buy",
    buyCost: 32_000,
    totalWin: 0,
    outcome: "feature",
    source: "weighted",
    seed: "user1-buy",
    validationStatus: "ok",
    userBalanceAfter: 99_968_400,
    steps: []
  });
  store.recordRound({
    sessionId: session1.id,
    roundNo: 3,
    kind: "free-feature",
    totalWin: 16_000,
    outcome: "medium",
    source: "weighted-free",
    seed: "user1-free",
    validationStatus: "ok",
    userBalanceAfter: 99_984_400,
    steps: []
  });

  const session2 = store.createSession({
    mode: "live",
    seed: "user2-session",
    configId: active.id,
    userId: user2.id
  });
  store.recordRound({
    sessionId: session2.id,
    roundNo: 1,
    kind: "base",
    bet: 400,
    totalWin: 0,
    outcome: "miss",
    source: "weighted",
    seed: "user2-base",
    validationStatus: "ok",
    userBalanceAfter: 99_999_600,
    steps: []
  });

  assert.deepEqual(store.listRounds({ token: "user1" }).map((round) => round.kind), [
    "free-feature",
    "buy",
    "base"
  ]);
  assert.deepEqual(store.listRounds({ token: "user2" }).map((round) => round.kind), ["base"]);
  assert.equal(store.getUser("user1").balance, 99_984_400);
  assert.equal(store.getUser("user2").balance, 99_999_600);

  const stats = store.getUserStats("user1");
  assert.equal(stats.roundCount, 3);
  assert.equal(stats.totalWager, 32_400);
  assert.equal(stats.totalWin, 16_800);
  assert.equal(stats.rtp, 16_800 / 32_400);
  assert.equal(store.listUsers()[0].token, "user2");
  store.close();
});

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
