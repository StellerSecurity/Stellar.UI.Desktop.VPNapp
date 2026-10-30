import test from 'node:test';
import assert from 'node:assert/strict';
import { autoConnectTarget } from '../src/features/connection/domain/AutoConnect.ts';
import { defaultSettings, type DesktopSnapshot } from '../src/contracts/desktop.ts';
const snapshot = (): DesktopSnapshot => ({ contractVersion: 1, runtime: 'native-preview', selectedServerId: 'dk-1', settings: { ...defaultSettings }, session: { authenticated: true, onboardingComplete: true }, connection: { status: 'disconnected', serverId: null, connectedAt: null } });
test('auto-connect is on by default and uses the saved live location', () => {
  assert.equal(defaultSettings.autoConnect, true);
  assert.equal(autoConnectTarget(snapshot(), true, ['de-1', 'dk-1'], false, false), 'dk-1');
});
test('catalog loading does not spend the single startup attempt', () => {
  assert.equal(autoConnectTarget(snapshot(), false, [], false, false), null);
  assert.equal(autoConnectTarget(snapshot(), true, ['dk-1'], false, false), 'dk-1');
});
test('no automatic tunnel without a restored authenticated and onboarded session', () => {
  assert.equal(autoConnectTarget(null, true, ['dk-1'], false, false), null);
  for (const session of [{ authenticated: false, onboardingComplete: true }, { authenticated: true, onboardingComplete: false }]) {
    assert.equal(autoConnectTarget({ ...snapshot(), session }, true, ['dk-1'], false, false), null);
  }
});
test('disabled, missing, busy and previously attempted startup do not reconnect', () => {
  assert.equal(autoConnectTarget({ ...snapshot(), settings: { ...defaultSettings, autoConnect: false } }, true, ['dk-1'], false, false), null);
  assert.equal(autoConnectTarget(snapshot(), true, ['de-1'], false, false), null);
  assert.equal(autoConnectTarget(snapshot(), true, ['dk-1'], false, true), null);
  assert.equal(autoConnectTarget(snapshot(), true, ['dk-1'], true, false), null);
});
test('an existing tunnel or a kill-switch block must not be replaced at startup', () => {
  for (const connection of [{ status: 'connected' as const, serverId: 'dk-1', connectedAt: 1 }, { status: 'disconnected' as const, serverId: null, connectedAt: null, trafficBlocked: true }]) {
    assert.equal(autoConnectTarget({ ...snapshot(), connection }, true, ['dk-1'], false, false), null);
  }
});
test('an explicitly inactive subscription never triggers automatic reconnection', () => {
  assert.equal(autoConnectTarget({ ...snapshot(), subscriptionAccess: { active: false, expiresAt: null } }, true, ['dk-1'], false, false), null);
});
