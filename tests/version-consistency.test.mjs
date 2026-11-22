import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseVersion = "0.5.1";

test("desktop release manifests agree on version 0.5.1", async () => {
  const [packageJson, tauriConfig, cargoManifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(packageJson).version, releaseVersion);
  assert.equal(JSON.parse(tauriConfig).version, releaseVersion);
  assert.match(cargoManifest, /^version = "0\.5\.1"$/m);
});
