import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(root, "vendor/cfb-0.14.0");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

test("the CFB patch contains only the reviewed source-only package", async () => {
  const provenance = JSON.parse(await readFile(resolve(vendorRoot, "stellar-source-only.json"), "utf8"));
  assert.equal(provenance.package, "cfb");
  assert.equal(provenance.version, "0.14.0");
  assert.equal(provenance.production_rust_changed, true);
  assert.equal(provenance.source_only_packaging, true);
  assert.equal(provenance.unused_upstream_external_fuzz_corpus_included, false);

  const actual = (await filesBelow(vendorRoot))
    .map(path => relative(vendorRoot, path).replaceAll("\\", "/"))
    .filter(path => !["Cargo.toml", "stellar-source-only.json"].includes(path))
    .sort();
  const expected = Object.keys(provenance.source_files).sort();
  assert.deepEqual(actual, expected);

  for (const path of expected) {
    const bytes = await readFile(resolve(vendorRoot, path));
    const patch = provenance.patched_production_files?.[path];
    const expectedHash = patch?.patched_sha256 ?? provenance.source_files[path].sha256;
    if (!patch) assert.equal(bytes.length, provenance.source_files[path].bytes, path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, path);
  }
});

test("the local CFB package disables auxiliary Cargo targets", async () => {
  const manifest = await readFile(resolve(vendorRoot, "Cargo.toml"), "utf8");
  for (const setting of ["build = false", "autobins = false", "autoexamples = false", "autotests = false", "autobenches = false"]) {
    assert.match(manifest, new RegExp(`^${setting}$`, "m"));
  }
  assert.doesNotMatch(manifest, /\[dev-dependencies/);

  const workspace = await readFile(resolve(root, "Cargo.toml"), "utf8");
  assert.match(workspace, /^cfb = \{ path = "vendor\/cfb-0\.14\.0" \}$/m);
});
