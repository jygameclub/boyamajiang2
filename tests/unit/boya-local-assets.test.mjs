import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

const assetRoot = new URL("../../local-har-client/boya-mahjong2/v2/assets/dy_mjlltwo_en/", import.meta.url);

test("locally restored normal-win symbol audio includes metadata and native MP3", async () => {
  const metadata = await stat(new URL(
    "import/52/525a9d05-9c3e-4144-b7b5-d3a6e77bd18e.698ef.json",
    assetRoot
  ));
  const audio = await stat(new URL(
    "native/52/525a9d05-9c3e-4144-b7b5-d3a6e77bd18e.aa65c.mp3",
    assetRoot
  ));

  assert.ok(metadata.size > 0);
  assert.ok(audio.size > 1000);
});
