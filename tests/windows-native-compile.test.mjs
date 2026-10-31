import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../scripts/windows-native-compile.ps1', import.meta.url), 'utf8');
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
