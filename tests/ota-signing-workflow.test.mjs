import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseArtifacts } from '../scripts/sign-ota-release.mjs';

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-ota-signing-')); }

test('discovers only final release artifacts', () => {
  const directory = temporary();
  try {
    for (const name of ['Stellar-VPN-setup.exe', 'Stellar VPN.app.tar.gz', 'Stellar VPN_0.5.3_amd64.deb']) fs.writeFileSync(path.join(directory, name), 'fixture');
    assert.deepEqual(releaseArtifacts(directory), [
      { name: 'Stellar-VPN-setup.exe', target: 'windows-x86_64', ota: true },
      { name: 'Stellar VPN.app.tar.gz', target: 'darwin-aarch64', ota: true },
      { name: 'Stellar VPN_0.5.3_amd64.deb', target: 'linux-x86_64', ota: true },
    ]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('macOS, Windows and Linux are all mandatory OTA targets', () => {
  const source = fs.readFileSync(new URL('../scripts/sign-ota-release.mjs', import.meta.url), 'utf8');
  const updater = fs.readFileSync(new URL('../src-tauri/src/updates/mod.rs', import.meta.url), 'utf8');
  const trust = fs.readFileSync(new URL('../src-tauri/src/updates/trust.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ota:\s*false/);
  for (const target of ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']) assert.match(source, new RegExp(target));
  assert.match(updater, /target_os = "linux"/);
  assert.match(updater, /linux::fetch_manifest/);
  assert.match(updater, /linux::download/);
  assert.match(updater, /linux::install/);
  assert.match(trust, /"linux-x86_64"/);
});

test('rejects signing-input intermediates', () => {
  const directory = temporary();
  try {
    fs.writeFileSync(path.join(directory, 'Stellar-VPN-setup.exe'), 'fixture');
    fs.writeFileSync(path.join(directory, 'stellar-windows-release-signing-input.zip'), 'fixture');
    assert.throws(() => releaseArtifacts(directory), /intermediates cannot be OTA signed/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
