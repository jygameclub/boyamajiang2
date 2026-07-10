import assert from "node:assert/strict";
import test from "node:test";

import { buildScenarioCatalog } from "../../tools/local/server/control-api.mjs";

test("admin scenario catalog exposes the route-and-cascade suite", () => {
  const catalog = buildScenarioCatalog();
  const suite = catalog.suites.find((entry) => entry.key === "route-and-cascade");

  assert.ok(suite);
  assert.equal(suite.scenarios.length, 12);
  assert.ok(suite.scenarios.some((scenario) => scenario.key === "cascade-gold-to-wild"));
  assert.ok(suite.scenarios.some((scenario) => scenario.key === "route-wild-reuse"));
});
