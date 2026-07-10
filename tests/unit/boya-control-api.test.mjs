import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScenarioCatalog,
  handleControlApi
} from "../../tools/local/server/control-api.mjs";
import { openLocalStore } from "../../tools/local/server/database.mjs";

async function requestAdmin(store, url) {
  let response;
  const handled = await handleControlApi(
    { method: "GET", url },
    {},
    {
      store,
      state: { startedAt: "now", counts: {} },
      sendJson(_res, payload, status = 200) {
        response = { payload, status };
      }
    }
  );
  assert.equal(handled, true);
  return response;
}

test("admin scenario catalog exposes the route-and-cascade suite", () => {
  const catalog = buildScenarioCatalog();
  const suite = catalog.suites.find((entry) => entry.key === "route-and-cascade");

  assert.ok(suite);
  assert.ok(suite.scenarios.length >= 28);
  assert.ok(catalog.suites.reduce((sum, entry) => sum + entry.scenarios.length, 0) >= 38);
  assert.ok(suite.scenarios.some((scenario) => scenario.key === "cascade-gold-to-wild"));
  assert.ok(suite.scenarios.some((scenario) => scenario.key === "route-wild-reuse"));
  const doubleGold = suite.scenarios.find((scenario) => scenario.key === "cascade-double-gold-to-wild");
  const scatterGravity = suite.scenarios.find((scenario) => scenario.key === "cascade-scatter-gravity");
  const multipleWild = suite.scenarios.find((scenario) => scenario.key === "route-multiple-wild-same-line");
  assert.equal(doubleGold.winSteps, 2);
  assert.deepEqual(doubleGold.multipliers, [1, 2]);
  assert.equal(doubleGold.minPeakWild, 2);
  assert.equal(scatterGravity.scatterCount, 2);
  assert.equal(multipleWild.scatterCount, 0);
});

test("admin user API exposes local balances and RTP by token", async () => {
  const store = openLocalStore(":memory:");
  const user = store.getOrCreateUser("usergame1");
  const session = store.createSession({
    mode: "live",
    seed: "api-user",
    configId: store.getActiveConfig().id,
    userId: user.id
  });
  store.recordRound({
    sessionId: session.id,
    roundNo: 1,
    kind: "base",
    bet: 400,
    totalWin: 800,
    outcome: "small",
    source: "weighted",
    seed: "api-round",
    validationStatus: "ok",
    userBalanceAfter: 100_000_400,
    steps: []
  });

  const list = await requestAdmin(store, "/api/admin/users");
  assert.equal(list.status, 200);
  assert.equal(list.payload.data.length, 1);
  assert.equal(list.payload.data[0].token, "usergame1");
  assert.equal(list.payload.data[0].balance, 100_000_400);
  assert.equal(list.payload.data[0].totalWager, 400);
  assert.equal(list.payload.data[0].totalWin, 800);
  assert.equal(list.payload.data[0].rtp, 2);

  const detail = await requestAdmin(store, "/api/admin/users/usergame1");
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.data.roundCount, 1);

  const missing = await requestAdmin(store, "/api/admin/users/missing-user");
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error, "USER_NOT_FOUND");
  store.close();
});
