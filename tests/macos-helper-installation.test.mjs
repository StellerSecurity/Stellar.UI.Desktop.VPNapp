import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src-tauri/src/infrastructure/vpn.rs', import.meta.url), 'utf8');
const start = source.indexOf('pub fn installation_check()');
const end = source.indexOf('\n#[cfg(target_os = "linux")]\npub fn linux_setup_issue', start);
const check = source.slice(start, end);

test('macOS setup detection uses the authenticated service boundary', () => {
  assert.ok(check.includes('/var/run/stellar-vpn/helper.sock'));
  assert.ok(check.includes('let Ok(mut stream) = helper()'));
  assert.ok(check.includes('stream.write_all(b"CAPABILITIES\\n")'));
  assert.ok(!check.includes('/Library/Application Support/Stellar VPN/stellar-vpn-helper'));
});
