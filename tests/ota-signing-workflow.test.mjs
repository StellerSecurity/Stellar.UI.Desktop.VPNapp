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
      { name: 'Stellar VPN_0.5.3_amd64.deb', target: 'linux-x86_64', ota: false },
    ]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('rejects signing-input intermediates', () => {
  const directory = temporary();
  try {
    fs.writeFileSync(path.join(directory, 'Stellar-VPN-setup.exe'), 'fixture');
    fs.writeFileSync(path.join(directory, 'stellar-windows-release-signing-input.zip'), 'fixture');
    assert.throws(() => releaseArtifacts(directory), /intermediates cannot be OTA signed/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
