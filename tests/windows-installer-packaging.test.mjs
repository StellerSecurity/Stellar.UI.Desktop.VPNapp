import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('Windows pipeline emits the final OTA installer filename without downloads', () => {
  const pipeline = read('azure-pipelines.yml');
  const packager = read('scripts/package-windows-ota-candidate.ps1');
  assert(pipeline.includes('scripts/package-windows-ota-candidate.ps1'));
  assert(pipeline.includes("'Stellar-VPN-setup.exe'"));
  assert(packager.includes("'windows-ota-installer-signing-input'"));
  assert(packager.includes("'Stellar-VPN-setup.exe'"));
  assert(packager.includes("'^3\\.10(?:\\D|$)'"));
  assert(packager.includes('Get-AuthenticodeSignature'));
  assert(packager.includes('authenticodeSigned = $false'));
  assert(packager.includes('otaSigned = $false'));
  assert(!/-or\s+Test-Path|-and\s+Test-Path/.test(packager));
  assert(!/Invoke-WebRequest|WebClient|HttpWebRequest|Start-BitsTransfer|winget|choco|npm|npx|curl|wget/i.test(packager));
});

test('NSIS installer is fixed per-machine and owns only Stellar paths', () => {
  const installer = read('native/windows/installer-release.nsi');
  assert(installer.includes('RequestExecutionLevel admin'));
  assert(installer.includes('InstallDir "$PROGRAMFILES64\\Stellar VPN"'));
  assert(installer.includes('!insertmacro NSIS_HOOK_PREINSTALL'));
  assert(installer.includes('!insertmacro NSIS_HOOK_POSTINSTALL'));
  assert(installer.includes('!insertmacro NSIS_HOOK_PREUNINSTALL'));
  assert(installer.includes('File /r "${STELLAR_STAGE}\\Runtime\\*.*"'));
  assert(installer.includes('WriteUninstaller "$INSTDIR\\Uninstall.exe"'));
  assert(!/ExecShell|nsExec|cmd\.exe|powershell|pnputil|netsh|sc\.exe|taskkill/i.test(installer));
  assert(!/RMDir \/r "\$(?!INSTDIR\\Runtime)/.test(installer));
});
