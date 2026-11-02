import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsSourceHash, verifyWindowsRelease } from '../scripts/check-windows-release.mjs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('Windows release evidence is invalidated when either native build entry point changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-windows-source-proof-'));
  try {
    for (const dir of ['native/windows', 'src-tauri/src', 'crates/stellar-core/src', 'src', 'scripts']) fs.mkdirSync(path.join(directory, dir), {recursive: true});
    for (const file of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/legacy-migration.json',
      'src-tauri/build.rs', 'Cargo.lock', 'package-lock.json', 'scripts/desktop.mjs', 'scripts/check-windows-release.mjs',
      'scripts/windows-native-compile.ps1', 'scripts/build-windows-helper.mjs']) fs.writeFileSync(path.join(directory, file), 'synthetic fixture');
    for (const name of ['scripts/windows-native-compile.ps1', 'scripts/build-windows-helper.mjs']) {
      const before = windowsSourceHash(directory);
      fs.appendFileSync(path.join(directory, name), '\nsynthetic source change');
      assert.notEqual(windowsSourceHash(directory), before, name);
    }
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
test('unaccepted native Windows sources cannot be distributed or advertised as tested', () => {
  const policy = JSON.parse(read('native/windows/release-policy.json'));
  assert.equal(policy.releaseReady, false); assert.equal(policy.runtimeApproved, false);
  assert.equal(policy.servicePersistenceApproved, true);
  assert.throws(() => verifyWindowsRelease(), /blocked/);
  assert.match(windowsSourceHash(), /^[a-f0-9]{64}$/);
});
test('Windows packages have a machine-level helper and never bundle the Mac installer', () => {
  const base = JSON.parse(read('src-tauri/tauri.conf.json'));
  const mac = JSON.parse(read('src-tauri/tauri.macos.conf.json'));
  const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
  assert.deepEqual(base.bundle.resources, []);
  assert.equal(mac.bundle.resources['resources/NetworkHelper.pkg'], 'NetworkHelper.pkg');
  assert.equal(win.bundle.windows.nsis.installMode, 'perMachine');
  assert.equal(win.bundle.resources['resources/windows/stellar-vpn-service.exe'], 'stellar-vpn-service.exe');
  assert(!JSON.stringify(win).includes('NetworkHelper.pkg'));
});
test('helper and bridge use native APIs, with no command shell or automatic third-party installer', () => {
  const source = ['common.hpp', 'bridge.cpp', 'service.cpp', 'lifecycle.hpp', 'firewall.hpp'].map(name => read('native/windows/' + name)).join('\n');
  assert(!/CreateProcess[AW]?\([^\n]*(?:cmd\.exe|powershell)|netsh\s|curl\s|wget\s/i.test(source));
  assert(source.includes('GetSystemDirectoryW'));
  assert(source.includes('verify_signature(install_root() / L"Runtime" / L"ovpn-dco.cat")'));
  for (const api of ['PIPE_REJECT_REMOTE_CLIENTS', 'ImpersonateNamedPipeClient', 'RevertToSelf', 'GetNamedPipeServerProcessId', 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'WinVerifyTrust', 'FwpmTransactionBegin0']) assert(source.includes(api), api);
  assert(read('native/windows/installer.nsh').includes('--uninstall-service'));
});
test('uninstall targets Stellar rules only and crash handling does not reset global firewall policy', () => {
  const firewall = read('native/windows/firewall.hpp');
  assert(firewall.includes('query.providerKey = const_cast<GUID*>(&provider_key)'));
  assert(firewall.includes('FwpmSubLayerDeleteByKey0(engine_, &sublayer_key)'));
  assert(firewall.includes('FwpmProviderDeleteByKey0(engine_, &provider_key)'));
  assert(!/netsh|RemoveAll|FirewallPolicy\.Reset/.test(firewall));
});
test('Windows vault identity is preserved across updates rather than renaming the credential target', () => {
  assert(read('src-tauri/src/infrastructure/session.rs').includes('org.stellarvpn.desktop.preview.session.v1'));
  assert(read('src-tauri/src/infrastructure/windows.rs').includes('stellar_windows_legacy_replace'));
  assert.equal(JSON.parse(read('src-tauri/legacy-migration.json')).enabled, false);
});
test('Windows owns one fixed adapter and never borrows or deletes shared VPN devices', () => {
  const lifecycle = read('native/windows/lifecycle.hpp');
  const service = read('native/windows/service.cpp');
  const installer = read('native/windows/installer.nsh');
  assert(lifecycle.includes('ROOT\\\\STELLARVPNDESKTOP\\\\0000'));
  assert(lifecycle.includes('SetupDiOpenDeviceInfoW(set, adapter_instance'));
  assert(lifecycle.includes('device.verify_owner()'));
  assert(lifecycle.includes('SPDRP_HARDWAREID'));
  assert(lifecycle.includes('DIF_REGISTERDEVICE'));
  assert(lifecycle.includes('DIF_REMOVE'));
  assert(!/SetupDiEnumDeviceInfo|DiUninstallDriver|\/delete-driver/.test(lifecycle));
  assert(service.includes('auto adapter = installed_adapter_guid()'));
  assert(service.includes('--dev-node'));
  assert(service.includes('remove_service(true); remove_owned_adapter();'));
  assert(service.includes('install_service(); return reboot ? ERROR_SUCCESS_REBOOT_REQUIRED : 0'));
  assert(installer.includes('StrCmp $0 3010 stellar_postinstall_reboot'));
  assert(installer.includes('SetRebootFlag true'));
  assert(!/^\s*Reboot\s*$/m.test(installer));
  assert(installer.indexOf('MB_OKCANCEL') < installer.indexOf('--stop-for-update'));
});
test('Windows setup diagnoses missing helpers and ARM hosts before requesting elevation', () => {
  const bridge = read('native/windows/bridge.cpp');
  const diagnostic = bridge.slice(bridge.indexOf('extern "C" int stellar_windows_setup_issue()'), bridge.indexOf('extern "C" intptr_t stellar_windows_instance()'));
  assert(diagnostic.includes('IsWow64Process2(GetCurrentProcess(), &process, &native)'));
  assert(diagnostic.includes('native != IMAGE_FILE_MACHINE_AMD64'));
  assert(diagnostic.includes('ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? 1 : 3'));
  assert(diagnostic.includes('FILE_ATTRIBUTE_REPARSE_POINT'));
  assert(diagnostic.includes('verify_signature(helper)'));
  assert(diagnostic.indexOf('check(stellar_windows_setup_issue() == 0)') < diagnostic.indexOf('execute.lpVerb = L"runas"'));
  assert(!diagnostic.includes('GetNativeSystemInfo'));
  assert(read('src-tauri/src/commands.rs').includes('setup_issue: Option<&\'static str>'));
});
