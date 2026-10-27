import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.platform === 'linux' && args[0] === 'build') {
  console.error('Linux distribution is blocked pending the upstream glib 0.18 VariantStrIter advisory (RUSTSEC-2024-0429). See SECURITY-REVIEW.local.md.');
  process.exit(1);
}
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env };
if (fs.existsSync(cargoBin)) env.PATH = cargoBin + path.delimiter + (env.PATH || '');
const cli = path.resolve('node_modules/@tauri-apps/cli/tauri.js');
if (!fs.existsSync(cli)) throw new Error('Tauri CLI is missing. Install the reviewed lockfile first.');
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
