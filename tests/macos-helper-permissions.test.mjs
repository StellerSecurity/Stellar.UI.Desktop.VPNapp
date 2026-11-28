import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = file => fs.readFileSync(file, 'utf8');

test('all macOS helper packagers override restrictive build umasks', () => {
  for (const file of [
    'scripts/package-network-helper.mjs',
    'scripts/package-macos-helper.mjs',
    'scripts/package-macos-installer.mjs',
  ]) {
    const source = read(file);
    assert.match(source, /chmodSync\(directory, 0o755\)/, `${file} must stage readable helper directories`);
  }
});

test('helper postinstall repairs directory traversal before launch', () => {
  const source = read('scripts/macos-helper/postinstall');
  const chmod = source.indexOf("/bin/chmod 755 '/Library/Application Support/Stellar VPN'");
  const bootstrap = source.indexOf('/bin/launchctl bootstrap system');
  assert(chmod >= 0 && bootstrap > chmod, 'postinstall must repair permissions before starting the helper');
});

test('install and uninstall migrate the legacy privileged helper', () => {
  for (const file of ['scripts/macos-helper/preinstall', 'scripts/macos-helper/uninstall']) {
    const source = read(file);
    assert.match(source, /org\.stellarsecurity\.vpn\.helper\.plist/);
    assert.match(source, /PrivilegedHelperTools\/stellar-vpn-helper-macos/);
    assert.match(source, /tmp\/stellar-vpn-helper\.sock/);
  }
});
