import assert from "node:assert/strict";
import test from "node:test";

test("local connection role is inferred from the first protocol command", async () => {
  const roleModule = await import("../../tools/local/server/connection-role.mjs").catch(() => null);
  assert.ok(roleModule, "connection role classifier must exist");

  for (const cmd of [10000, 20047, 20049, 20152, 70000]) {
    assert.equal(roleModule.inferLocalConnectionIndex(cmd), 0, `hall command ${cmd}`);
  }
  for (const cmd of [31008, 31010, 40000, 40002, 40004, 40006]) {
    assert.equal(roleModule.inferLocalConnectionIndex(cmd), 1, `game command ${cmd}`);
  }
  assert.equal(roleModule.inferLocalConnectionIndex(99999), 0);
});
