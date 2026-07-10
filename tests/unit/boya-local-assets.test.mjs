import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const assetRoot = new URL("../../local-har-client/boya-mahjong2/v2/assets/dy_mjlltwo_en/", import.meta.url);
const sharedAssetRoot = new URL("../../local-har-client/boya-mahjong2/v2/assets/resources/", import.meta.url);

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

test("locally restored auto-spin dialog includes its lazy-loaded prefab package", async () => {
  const files = await Promise.all([
    "import/0b/0b45ea3c9.cdb02.json",
    "import/b9/b9140739-1ed5-49b7-a6bd-d211fc3e7653.9cd52.json",
    "import/a3/a3e01927-1762-4fb4-ad78-bcf4d129bc35.38be2.json"
  ].map((relativePath) => stat(new URL(relativePath, sharedAssetRoot))));

  assert.ok(files.every((file) => file.size > 100));
});

test("restored client gateway fallback is local and contains no production host", async () => {
  const source = await readFile(new URL(
    "../../local-har-client/boya-mahjong2/v2/src/assets/gateConfig.6e55b.js",
    import.meta.url
  ), "utf8");

  assert.match(source, /window\.location\.host/);
  assert.doesNotMatch(source, /gateway(?:2020)?\.666789\.site/);
});
