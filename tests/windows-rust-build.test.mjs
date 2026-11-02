import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('Windows Rust job pins only the approved graph and first-party source inputs', () => {
  const approval = JSON.parse(read('native/windows/rust-build-approval.json'));
  assert.equal(approval.approved, true);
  assert.equal(approval.releaseApproved, false);
  assert.equal(approval.packages.length, 410);
  assert.equal(approval.lockSha256, createHash('sha256').update(read('Cargo.lock')).digest('hex'));
  const manifest = JSON.parse(read('scripts/windows-rust-inputs.json'));
  assert.equal(new Set(manifest.files.map(f => f.path)).size, manifest.files.length);
  for (const file of manifest.files) {
    assert(!/\.md$/i.test(file.path), file.path);
    assert(!file.path.includes('..') && !/\.env|credentials|node_modules|\/Runtime\//.test(file.path), file.path);
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../' + file.path, import.meta.url))).digest('hex'), file.sha256, file.path);
  }
});
test('Rust workflow validates the harness and uses only its pinned first-party export action', () => {
  const workflow = read('.github/workflows/windows-rust-build.yml');
  assert(workflow.includes('permissions: {}'));
  assert(!/secrets\.|actions\/checkout/.test(workflow));
  assert.deepEqual([...workflow.matchAll(/uses:\s*(\S+)/g)].map(x => x[1]), ['./.github/actions/upload-windows-interface-test']);
  for (const [, name, hash] of workflow.matchAll(/path = '([^']+)'; sha256 = '([a-f0-9]{64})'/g))
    assert.equal(createHash('sha256').update(read(name)).digest('hex'), hash, name);
  const script = read('scripts/windows-rust-build.ps1');
  for (const guard of ['Get-FileHash', 'Get-AuthenticodeSignature', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_HOME', 'Verify-Lock', 'CARGO_NET_OFFLINE', 'cargo test --locked --offline', 'cargo build --locked --offline']) assert(script.includes(guard), guard);
  assert(!/&\s*[^\n]*rustup|\bnpm\b|\bwinget\b|\bchoco\b|\bpnputil\b|New-Service|Start-Service|Start-Process|Invoke-Expression/.test(script));
  assert(script.includes('--features tauri/custom-protocol'));
  assert(script.includes('Exact six-file frontend snapshot required.'));
  assert(script.includes('vpnRuntimeIncluded = $false; serviceIncluded = $false; driverIncluded = $false'));
  assert(script.includes("Compress-Archive -LiteralPath $executable, (Join-Path $output 'build-info.json')"));
});
