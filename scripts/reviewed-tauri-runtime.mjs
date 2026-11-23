import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'vendor', 'tauri-cli-reviewed', 'runtime-manifest.json');

function hostTarget() {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) return `darwin-${process.arch}`;
  if (process.platform === 'win32' && ['arm64', 'ia32', 'x64'].includes(process.arch)) return `win32-${process.arch}`;
  if (process.platform !== 'linux') throw new Error('The reviewed Tauri CLI has no runtime for this platform.');
  const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl';
  if (!['arm', 'arm64', 'riscv64', 'x64'].includes(process.arch)) throw new Error('The reviewed Tauri CLI has no runtime for this Linux architecture.');
  return `linux-${process.arch}-${libc}`;
}

export function verifyReviewedTauriRuntime(runtime, approved) {
  const metadata = fs.lstatSync(runtime, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== approved.bytes) {
    throw new Error('The reviewed Tauri CLI runtime is missing or has changed.');
  }
  const checksum = createHash('sha256').update(fs.readFileSync(runtime)).digest('hex');
  if (checksum !== approved.sha256) throw new Error('The reviewed Tauri CLI runtime hash does not match.');
}

export function reviewedTauriRuntime() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const target = hostTarget();
  const approved = manifest.targets?.[target];
  if (!approved || manifest.package_version !== '2.12.4') throw new Error('The Tauri CLI host is not approved.');

  const runtime = path.join(root, '.stellar-build-tools', 'tauri', approved.filename);
  verifyReviewedTauriRuntime(runtime, approved);
  return { runtime, target, approved };
}

export async function runReviewedTauri(args, binName = 'node scripts/desktop.mjs') {
  const { runtime } = reviewedTauriRuntime();
  const binding = createRequire(import.meta.url)(runtime);
  if (typeof binding?.run !== 'function') throw new Error('The reviewed Tauri CLI runtime has an incompatible interface.');
  await new Promise((resolve, reject) => {
    binding.run(args, binName, (error) => error ? reject(error) : resolve());
  });
}
