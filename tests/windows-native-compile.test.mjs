import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = fs.readFileSync(new URL('../scripts/windows-native-compile.ps1', import.meta.url), 'utf8');
test('hosted compile source pins match exact local files and keep credentials and third-party actions out', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/windows-native-compile.yml', import.meta.url), 'utf8');
  const pins = [...workflow.matchAll(/path = '([^']+)'; sha256 = '([a-f0-9]{64})'/g)];
  assert.equal(pins.length, 8);
  for (const [, path, hash] of pins) {
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../' + path, import.meta.url))).digest('hex'), hash, path);
  }
  assert(workflow.includes('permissions: {}'));
  assert(!/uses:|secrets\.|actions\/checkout/.test(workflow));
  const approval = JSON.parse(fs.readFileSync(new URL('../native/windows/compile-approval.json', import.meta.url), 'utf8'));
  assert.equal(approval.scope, 'native-cpp-compile-only');
  assert.equal(approval.components.length, 66);
  assert.equal(new Set(approval.components.map(c => c.name)).size, 66);
  assert(approval.components.every(c => /^[a-f0-9]{64}$/.test(c.sha256) && c.signer.includes('O=Microsoft Corporation')));
});
test('native Windows compile is approval/hash/signature gated and never PATH-selects executables', () => {
  for (const value of ['windows-native-compile-approval.json', "$review.approved -ne $true", '14.44.35229.0', 'Get-FileHash', 'Get-AuthenticodeSignature', 'O=Microsoft Corporation', "$tools['cl.exe']", "$tools['lib.exe']", "$tools['link.exe']", 'Unreviewed compiler component present', '$env:_CL_', '$env:_LINK_']) assert(source.includes(value), value);
  assert(!/&\s*['"]?(?:cl|lib|link)(?:\.exe)?['"]?\s/.test(source));
});
test('compile-only phase never starts service binaries, installs drivers or fetches packages', () => {
  assert(source.includes('executed = $false'));
  assert(source.includes('/WHOLEARCHIVE:'));
  assert(!/Start-Service|New-Service|pnputil|msiexec|Invoke-WebRequest|Invoke-RestMethod|DownloadFile|winget|choco|npm|rustup|cargo\s+install/.test(source));
  for (const line of source.split('\n').filter(line => line.trimStart().startsWith('& '))) {
    assert.match(line, /^\s*& \$tools\['(?:cl|lib|link)\.exe'\]/);
  }
});
