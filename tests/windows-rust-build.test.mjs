import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('Windows Rust job pins only the approved graph and first-party source inputs', () => {
  const approval = JSON.parse(read('native/windows/rust-build-approval.json'));
  assert.equal(approval.approved, true);
  assert.equal(approval.releaseApproved, false);
  assert.equal(approval.packages.length, 407);
  assert(!approval.packages.some(pkg => ['embed-resource', 'vswhom', 'vswhom-sys'].includes(pkg.name)));
  const vendor = approval.vendoredSourceExecutionApproval;
  assert.equal(typeof vendor.approved, 'boolean');
  assert.equal(vendor.scope, 'exact-embed-resource-3.0.12-stellar-revision-1-debug-build-and-synthetic-tests');
  assert.equal(vendor.sourcePlanSha256, '32c2344d561eaefef9d3a09010b0158804a36e62fd2b63b219562f066728c289');
  assert.equal(vendor.files.length, 7);
  assert.equal(new Set(vendor.files.map(file => file.path)).size, 7);
  for (const file of vendor.files) {
    assert.match(file.path, /^vendor\/embed-resource-3\.0\.12\/(Cargo\.toml|LICENSE|stellar-patch\.json|src\/(lib|windows_msvc|windows_not_msvc|non_windows)\.rs)$/);
    assert.equal(createHash('sha256').update(read(file.path)).digest('hex'), file.sha256);
  }
  assert.equal(approval.sdkVersion, '10.0.26100.9457');
  assert.equal(typeof approval.sdkExecutionApproval.approved, 'boolean');
  assert.equal(approval.sdkExecutionApproval.scope, 'exact-installed-sdk-debug-build-and-synthetic-tests');
  assert.equal(approval.sdkExecutionApproval.version, approval.sdkVersion);
  assert.deepEqual(approval.sdk.map(file => file.name).sort(), ['ServicingCommon.dll', 'rc.exe', 'rcdll.dll']);
  assert(approval.sdk.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.signatureStatus === 'Valid'));
  const sourceLock = read('Cargo.lock');
  assert.equal(approval.sourceLockSha256, createHash('sha256').update(sourceLock).digest('hex'));
  assert.deepEqual(approval.firstPartyLockVersion, { name: 'stellar-vpn-desktop', from: '0.1.0', to: '0.5.1' });
  const original = sourceLock.replace('name = "stellar-vpn-desktop"\nversion = "0.5.1"', 'name = "stellar-vpn-desktop"\nversion = "0.1.0"');
  assert.equal(approval.lockSha256, createHash('sha256').update(original).digest('hex'));
  const manifest = JSON.parse(read('scripts/windows-rust-inputs.json'));
  assert.equal(new Set(manifest.files.map(f => f.path)).size, manifest.files.length);
  for (const file of vendor.files) {
    assert.deepEqual(manifest.files.find(input => input.path === file.path), file);
  }
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
  assert(script.indexOf('Exact changed SDK execution approval required.') < script.indexOf('& $cargo fetch'));
  assert(script.indexOf('Separate execution approval for the exact vendored source patch is required.') < script.indexOf('& $cargo fetch'));
  assert(script.includes('$review.vendoredSourceExecutionApproval.approved -ne $true'));
  assert(script.includes('Reviewed vendored source changed.'));
  assert(script.includes('Exact seven-file vendored source review required.'));
  assert(script.includes("@('rc.exe', 'rcdll.dll', 'ServicingCommon.dll')"));
  assert(script.includes('Exact three-file SDK bundle required.'));
});

test('SDK review executes only hash-pinned first-party code and never loads SDK images', () => {
  const workflow = read('.github/workflows/windows-sdk-static-review.yml');
  const script = read('scripts/windows-sdk-static-review.ps1');
  assert(workflow.includes('permissions: {}'));
  assert(!/uses:|secrets\.|github\.token/.test(workflow));
  const hash = /\$hash -ne '([a-f0-9]{64})'/.exec(workflow)?.[1];
  assert.equal(hash, createHash('sha256').update(script).digest('hex'));
  assert(script.includes('binariesExecuted = $false'));
  assert(script.includes('executionApproved = $false'));
  assert(!/Start-Process|Invoke-Expression|DllImport|LoadLibrary\s*\(|Assembly\]::Load|Add-Type|&\s*\$file/.test(script));
  assert(script.includes('Get-AuthenticodeSignature'));
  assert(script.includes('ServicingCommon.dll'));
});
