// Existing reviewed build tools only. No downloads, installation, signing or app launch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageOptions, rustTarget, verifyRuntime } from './macos-architecture.mjs';

const args = process.argv.slice(2), checkOnly = args.includes('--check');
const { arch, profile, runtime } = packageOptions(args.filter(arg => arg !== '--check'));
if (process.platform !== 'darwin') throw new Error('Build on macOS with the reviewed Xcode tools');
const target = rustTarget(arch), cargoDirectory = path.join(os.homedir(), '.cargo/bin');
const installed = execFileSync(path.join(cargoDirectory, 'rustup'), ['target','list','--installed'], { encoding:'utf8' }).trim().split(/\s+/);
const blockers = [];
if (!installed.includes(target)) blockers.push(`Reviewed Rust target is not installed: ${target}`);
try { verifyRuntime(runtime, arch); } catch (error) { blockers.push(`Reviewed ${arch} VPN runtime unavailable: ${error.message}`); }
if (blockers.length) { console.error(blockers.join('\n')); console.error('No download or installation attempted. Security review and explicit approval are required for missing components.'); process.exit(1); }
if (checkOnly) { console.log(`Preflight passed: ${arch}, ${target}, ${runtime}`); process.exit(0); }
const env = { ...process.env, PATH: cargoDirectory + path.delimiter + (process.env.PATH || ''), CARGO_NET_OFFLINE:'true', MACOSX_DEPLOYMENT_TARGET:'12.0' };
for (const key of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_PATH','APPLE_API_ISSUER','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID']) delete env[key];
function run(command, options) { execFileSync(command, options, { stdio:'inherit', env }); }
run(path.join(cargoDirectory,'cargo'), ['build','--locked','--offline','-p','stellar-vpn-helper','--target',target, ...(profile === 'release' ? ['--release'] : [])]);
run(process.execPath, ['scripts/package-network-helper.mjs','--arch',arch,'--profile',profile,'--runtime',runtime,'--helper',`target/${target}/${profile}/stellar-vpn-helper`]);
run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js','build','--target',target,'--bundles','app','--no-sign', ...(profile === 'debug' ? ['--debug'] : [])]);
const app = path.resolve(`target/${target}/${profile}/bundle/macos/Stellar VPN.app`);
if (!fs.existsSync(app)) throw new Error('Expected architecture-specific app bundle was not generated');
run(process.execPath, ['scripts/prepare-drag-dmg.mjs', app]);
console.log('App built and drag-DMG inputs staged. Use hdiutil with the printed stage/output paths; nothing installed.');
