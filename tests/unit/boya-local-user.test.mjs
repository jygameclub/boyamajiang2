import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_USER_BALANCE,
  DEFAULT_LOCAL_USER_TOKEN,
  normalizeLocalUserToken
} from "../../tools/local/server/local-user.mjs";

test("local user tokens preserve supported names and reject unsafe values", () => {
  assert.equal(DEFAULT_LOCAL_USER_BALANCE, 100_000_000);
  assert.equal(DEFAULT_LOCAL_USER_TOKEN, "local-default");
  assert.equal(normalizeLocalUserToken("user1"), "user1");
  assert.equal(normalizeLocalUserToken("user2"), "user2");
  assert.equal(normalizeLocalUserToken("usergame1"), "usergame1");
  assert.equal(normalizeLocalUserToken(), "local-default");
  assert.throws(() => normalizeLocalUserToken("../user1"), /LOCAL_USER_TOKEN_INVALID/);
  assert.throws(() => normalizeLocalUserToken("user one"), /LOCAL_USER_TOKEN_INVALID/);
});

