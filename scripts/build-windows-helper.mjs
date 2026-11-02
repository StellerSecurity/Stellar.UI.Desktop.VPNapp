// One hash/signature-gated Microsoft toolchain implementation, shared with Cargo.
// Never installs or downloads anything. Only first-party compilation is performed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('An approved native Windows x64 MSVC environment is required.');
const powershell = path.join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
if (!path.isAbsolute(powershell) || !fs.existsSync(powershell)) throw new Error('Built-in Windows PowerShell is required.');
const parent = path.resolve('target/windows-helper'); fs.mkdirSync(parent, { recursive: true });
const output = path.join(parent, `build-${process.pid}-${Date.now()}`);
const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/windows-native-compile.ps1'), '-OutputDirectory', output],
  { stdio: 'inherit', shell: false });
if (result.error || result.status !== 0) throw new Error('Verified Windows helper compilation failed.');
console.log(`First-party helper compiled at ${output}. NOT signed, installed, driver-equipped or release-approved.`);
