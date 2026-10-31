import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../scripts/windows-toolchain-inventory.ps1', import.meta.url), 'utf8');
test('Windows inventory reads exact tool metadata without executing discovered binaries', () => {
  assert(source.includes('Get-FileHash'));
  assert(source.includes('$file.VersionInfo.ProductVersion'));
  assert(source.includes('approved = $false'));
  assert(source.includes('signatureVerified = $false'));
  assert(!/Start-Process|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod|DownloadFile|\bwinget\b|\bchoco\b|&\s*\$command/i.test(source));
  assert(!/Get-ChildItem[^\n]*-Recurse|Get-ChildItem[^\n]*Env:|Get-Content[^\n]*(?:\.env|credential|token|profile)/i.test(source));
});
test('hosted inventory uses no third-party actions, credentials, checkout or installs', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/windows-toolchain-inventory.yml', import.meta.url), 'utf8');
  assert(workflow.includes('runs-on: windows-2022'));
  assert(workflow.includes('shell: powershell'));
  assert(workflow.includes('permissions: {}'));
  assert(!/uses:|secrets\.|github\.token|pull_request_target|npm (?:ci|install)|cargo (?:build|install)|rustup (?:update|target add)|winget install|choco install/.test(workflow));
  const inline = workflow.split('        run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  assert.equal(inline.trimEnd(), source.trimEnd(), 'hosted inventory must match the locally reviewed script');
});
