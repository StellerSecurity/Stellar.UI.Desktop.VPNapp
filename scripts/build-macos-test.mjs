// Existing reviewed build tools only. No downloads, installation, signing or app launch.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageOptions, rustTarget, verifyRuntime } from './macos-architecture.mjs';
import { runReviewedTauri } from './reviewed-tauri-runtime.mjs';

const args = process.argv.slice(2), checkOnly = args.includes('--check');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { arch, profile, runtime } = packageOptions(args.filter(arg => arg !== '--check'));
if (process.platform !== 'darwin') throw new Error('Build on macOS with the reviewed Xcode tools');
const target = rustTarget(arch);
function installedTool(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`Required preinstalled build tool is missing: ${name}`);
}
const cargo = installedTool('cargo'), rustc = installedTool('rustc');
const rustSysroot = execFileSync(rustc, ['--print','sysroot'], { encoding:'utf8' }).trim();
const targetLibrary = path.join(rustSysroot, 'lib', 'rustlib', target, 'lib');
const blockers = [];
if (!fs.statSync(targetLibrary, { throwIfNoEntry:false })?.isDirectory()) blockers.push(`Reviewed Rust target is not installed: ${target}`);
try { verifyRuntime(runtime, arch); } catch (error) { blockers.push(`Reviewed ${arch} VPN runtime unavailable: ${error.message}`); }
if (blockers.length) { console.error(blockers.join('\n')); console.error('No download or installation attempted. Security review and explicit approval are required for missing components.'); process.exit(1); }
if (checkOnly) { console.log(`Preflight passed: ${arch}, ${target}, ${runtime}`); process.exit(0); }
const env = { ...process.env, CARGO_NET_OFFLINE:'true', MACOSX_DEPLOYMENT_TARGET:'12.0' };
for (const key of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_PATH','APPLE_API_ISSUER','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID']) delete env[key];
Object.assign(process.env, env);
for (const key of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_PATH','APPLE_API_ISSUER','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID']) delete process.env[key];
function run(command, options) { execFileSync(command, options, { stdio:'inherit', env, cwd:root }); }
run(cargo, ['build','--locked','--offline','-p','stellar-vpn-helper','--target',target, ...(profile === 'release' ? ['--release'] : [])]);
run(process.execPath, [path.join(root,'scripts/package-network-helper.mjs'),'--arch',arch,'--profile',profile,'--runtime',runtime,'--helper',path.join(root,`target/${target}/${profile}/stellar-vpn-helper`)]);
await runReviewedTauri(['build','--target',target,'--bundles','app','--no-sign', ...(profile === 'debug' ? ['--debug'] : [])],
                       'node scripts/build-macos-test.mjs');
const app = path.join(root, `target/${target}/${profile}/bundle/macos/Stellar VPN.app`);
if (!fs.existsSync(app)) throw new Error('Expected architecture-specific app bundle was not generated');
run(process.execPath, [path.join(root,'scripts/prepare-drag-dmg.mjs'), app]);
console.log('App built and drag-DMG inputs staged. Use hdiutil with the printed stage/output paths; nothing installed.');
