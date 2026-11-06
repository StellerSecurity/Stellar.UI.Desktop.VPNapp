import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('registered desktop commands are reachable through the local main and tray capability', () => {
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const permission = readFileSync(new URL('../src-tauri/permissions/desktop.toml', import.meta.url), 'utf8');
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/main.json', import.meta.url), 'utf8'));
  const handler = lib.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(handler, 'Native command registration must be inspectable');
  const allowed = new Set([...permission.matchAll(/"([a-z_]+)"/g)].map(match => match[1]));
  const registered = [...handler.matchAll(/commands::([a-z_]+)/g)].map(match => match[1]);
  assert.ok(registered.length > 0);
  assert.deepEqual(registered.filter(name => !allowed.has(name)), [], 'Registered native commands missing from IPC permissions');
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.windows, ['main', 'tray']);
  assert.ok(capability.permissions.includes('allow-desktop-preview'));
});
