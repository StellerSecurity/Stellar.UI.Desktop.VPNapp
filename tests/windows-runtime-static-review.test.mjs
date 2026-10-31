import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('Windows runtime review pins approved bytes and never installs or executes the MSI', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/windows-runtime-static-review.yml', import.meta.url), 'utf8');
  assert(source.includes('permissions: {}'));
  assert(source.includes('33104dd02c48cba172612882b1af6276422b1b4340d4c9c84dd2afb4b356fe9f'));
  assert(source.includes('$installer.OpenDatabase([string]$file, [int]0)'));
  assert(source.includes('Get-AuthenticodeSignature'));
  assert(source.includes('$request.AllowAutoRedirect = $false'));
  assert(!/uses:|Start-Process|msiexec\.exe|Expand-Archive|Invoke-Expression|InstallProduct\s*\(/i.test(source));
  assert(source.includes('"packageExecuted":false'));
  assert(source.includes('"driverInstalled":false'));
});
