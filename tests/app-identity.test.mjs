import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const identifier = 'org.stellarsecurity.vpn.desktop';

test('desktop bundle, update trust and development signing use the legacy production app identity', () => {
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).identifier, identifier);
  assert.ok(read('src-tauri/src/updates/trust.rs').includes(`pub const PRODUCT: &str = "${identifier}";`));
  assert.ok(read('scripts/desktop.mjs').includes(`'--identifier', '${identifier}'`));
});

test('new app packaging requires the selected identity; removal retains explicit preview compatibility', () => {
  for (const file of ['scripts/prepare-drag-dmg.mjs', 'scripts/package-macos-installer.mjs']) {
    const source = read(file);
    assert.ok(source.includes(`identifier !== '${identifier}'`));
    assert.ok(!source.includes('org.stellarvpn.desktop.preview'));
  }
  assert.ok(read('scripts/macos-installer/uninstall-preinstall').includes(
    `${identifier}|org.stellarvpn.desktop.preview|org.stellarvpn.desktop)`));
});
