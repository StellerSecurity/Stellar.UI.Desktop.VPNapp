import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const unit = fs.readFileSync('scripts/linux/stellar-vpn@.service', 'utf8');
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.linux.conf.json', 'utf8'));

test('the Debian package installs only the fixed helper and service paths', () => {
  assert.deepEqual(config.bundle.targets, ['deb']);
  assert.deepEqual(config.bundle.linux.deb.files, {
    '/usr/lib/stellar-vpn/stellar-vpn-helper': '../target/release/stellar-vpn-helper',
    '/lib/systemd/system/stellar-vpn@.service': '../scripts/linux/stellar-vpn@.service',
  });
});

test('the root helper service is bounded and hardened', () => {
  for (const required of [
    'ExecStart=/usr/lib/stellar-vpn/stellar-vpn-helper %i',
    'ExecStopPost=/usr/lib/stellar-vpn/stellar-vpn-helper --unblock',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_NET_ADMIN CAP_NET_RAW',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    'UMask=0077',
  ]) assert(unit.includes(required), required);
  assert(!unit.includes('EnvironmentFile=') && !unit.includes('/bin/sh'));
});
