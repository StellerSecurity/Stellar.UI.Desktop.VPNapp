import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseVersion = "0.5.3";

test("desktop release manifests agree on version 0.5.3", async () => {
  const [packageJson, tauriConfig, cargoManifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(packageJson).version, releaseVersion);
  assert.equal(JSON.parse(tauriConfig).version, releaseVersion);
  const packageSection = cargoManifest
    .split(/^\[/m)
    .find((section) => section.startsWith("package]\n"));
  assert.ok(packageSection, "src-tauri/Cargo.toml must contain a package section");
  assert.match(packageSection, /^version = "0\.5\.3"$/m);
});
