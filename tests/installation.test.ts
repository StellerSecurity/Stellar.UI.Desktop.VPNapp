import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInstallation, installationReady, requiresInstallationHelp, type InstallationStatus } from '../src/features/setup/domain/Installation.ts';
import { InstallationService } from '../src/features/setup/application/InstallationService.ts';
import { installationHelpState } from '../src/features/setup/domain/InstallationHelpState.ts';
const ready: InstallationStatus = { platform: 'macos', helper: 'ready', firewallVerified: true, language: 'Dansk' };
test('installation status validates untrusted native output', () => {
  assert.deepEqual(decodeInstallation(ready), ready);
  for (const value of [null, {}, { ...ready, helper: 'yes' }, { ...ready, firewallVerified: 'true' }, { ...ready, language: 'x'.repeat(65) }]) assert.throws(() => decodeInstallation(value));
});
test('Windows uses the same truthful helper readiness and explicit repair flow', () => {
  const windows = { ...ready, platform: 'windows' as const };
  assert.deepEqual(decodeInstallation(windows), windows);
  assert.equal(installationReady(windows), true);
  assert.equal(installationReady({ ...windows, firewallVerified: false }), true);
  assert.equal(requiresInstallationHelp({ ...windows, helper: 'unavailable' }), true);
});
test('helper readiness never implies firewall verification', () => {
  assert.equal(installationReady({ ...ready, firewallVerified: false }), true);
  for (const helper of ['missing', 'outdated', 'unavailable'] as const) assert.equal(installationReady({ ...ready, helper }), false);
  assert.equal(installationReady({ ...ready, platform: 'unsupported' }), false);
});
test('healthy and pending checks never add a mandatory setup step', () => {
  assert.equal(requiresInstallationHelp(null), false);
  assert.equal(requiresInstallationHelp(ready), false);
  assert.equal(requiresInstallationHelp({ ...ready, firewallVerified: false }), false);
  assert.equal(requiresInstallationHelp({ ...ready, platform: 'unsupported' }), false);
});
test('only missing, outdated, unavailable and failed checks show repair help', () => {
  for (const helper of ['missing', 'outdated', 'unavailable'] as const) assert.equal(requiresInstallationHelp({ ...ready, helper }), true);
  assert.equal(requiresInstallationHelp(null, true), true);
  assert.equal(requiresInstallationHelp(ready, true), true);
});
test('the installation service is read-only', async () => {
  const service = new InstallationService({ check: async () => ready });
  assert.deepEqual(await service.check(), ready);
});
test('background checks never open an installer; only explicit action can', async () => {
  let opened = 0;
  const service = new InstallationService({ check: async () => ({ ...ready, helper: 'missing' }), openHelper: async () => { opened++; } });
  await service.check(); assert.equal(opened, 0);
  await service.openHelper(); assert.equal(opened, 1);
});
test('an unavailable installer never claims it was opened', async () => {
  await assert.rejects(new InstallationService({ check: async () => ready }).openHelper(), /unavailable/);
});
test('unresponsive system check times out', async () => {
  const service = new InstallationService({ check: () => new Promise(() => {}) }, 10);
  await assert.rejects(service.check(), /timed out/);
});
test('native setup issues are validated and never imply readiness', () => {
  for (const setupIssue of ['installer_required', 'unsupported_architecture', 'helper_untrusted'] as const) {
    const status = { ...ready, platform: 'windows' as const, setupIssue };
    assert.deepEqual(decodeInstallation(status), status);
    assert.equal(installationReady(status), false);
    assert.equal(requiresInstallationHelp(status), true);
    const help = installationHelpState(status, false, true, true);
    assert.equal(help.retryOnly, true);
    assert.equal(help.button, 'Check again');
    assert.equal(help.diagnostic, null);
    assert(!help.footnote.includes('administrator'));
  }
  for (const setupIssue of ['ready', {}, true, 2]) assert.throws(() => decodeInstallation({ ...ready, setupIssue }));
  assert.deepEqual(decodeInstallation({ ...ready, setupIssue: null }), ready);
});
test('a failed repair has one error, not a status plus an identical alert', () => {
  const help = installationHelpState({ ...ready, helper: 'unavailable' }, true, true, false);
  assert.equal(help.diagnostic, 'Setup could not finish. Check macOS permission prompts and try again.');
  assert.equal(help.alert, true);
  assert.equal(help.retryOnly, false);
});
test('normal Mac repair and Windows installed-helper recovery are preserved', () => {
  for (const platform of ['macos', 'windows'] as const) {
    assert.equal(installationHelpState({ ...ready, platform, helper: 'missing' }, false, false, false).button, 'Install network helper');
    assert.equal(installationHelpState({ ...ready, platform, helper: 'missing' }, false, false, true).button, 'Try again');
  }
});
