import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commands = {
  build: ['build'],
  dev: ['--host', '127.0.0.1', '--port', '4176', '--strictPort'],
  preview: ['preview', '--host', '127.0.0.1', '--port', '4177', '--strictPort'],
};
const mode = process.argv[2] ?? 'build';
if (process.argv.length > 3 || !Object.hasOwn(commands, mode)) {
  throw new Error('Choose only build, dev or preview without additional arguments.');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeOS = process.platform === 'win32' ? 'windows' : process.platform;
const runtimeArch = process.arch === 'x64' ? 'amd64' : process.arch;
const suffix = process.platform === 'win32' ? '.exe' : '';
const defaultRuntime = path.join(root, '.stellar-build-tools', 'esbuild', `esbuild-${runtimeOS}-${runtimeArch}${suffix}`);
process.env.ESBUILD_BINARY_PATH ??= defaultRuntime;

// The source package verifies the exact supported host, size and SHA-256 before
// either Vite or the runtime starts. There is no fallback download or installer.
const require = createRequire(import.meta.url);
const binary = require('esbuild/lib/reviewed-binary.cjs')();
const cli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(process.execPath, [...process.execArgv, cli, ...commands[mode]], {
  cwd: root,
  env: { ...process.env, ESBUILD_BINARY_PATH: binary },
  stdio: 'inherit',
  shell: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  console.error('The reviewed frontend build could not start.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
