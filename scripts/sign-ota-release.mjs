#!/usr/bin/env node
// Local release signing only. The private key is passed by path to the reviewed
// Tauri signer and is never copied, uploaded, printed or read by this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewedTauri } from './reviewed-tauri-runtime.mjs';
import { PINNED_PUBLIC_KEY, verifyRelease } from './prepare-ota-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) { throw new Error(message); }
function regular(file, label) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${file}`);
  return stat;
}

export function releaseArtifacts(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) fail('Signing input directory must not contain symlinks.');
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const definitions = [
    { name: 'Stellar-VPN-setup.exe', target: 'windows-x86_64', ota: true },
    { name: 'Stellar VPN.app.tar.gz', target: 'darwin-aarch64', ota: true },
  ];
  const artifacts = definitions.filter(item => files.includes(item.name));
  const linux = files.filter(name => /^Stellar VPN_0\.5\.3_amd64\.deb$/.test(name));
  for (const name of linux) artifacts.push({ name, target: 'linux-x86_64', ota: false });
  if (!artifacts.length) fail('No final release artifacts found. Expected Stellar-VPN-setup.exe, Stellar VPN.app.tar.gz or Stellar VPN_0.5.3_amd64.deb.');
  if (files.some(name => /(?:unsigned|signing-input)/i.test(name))) {
    fail('Unsigned/signing-input intermediates cannot be OTA signed. Add the final installer/archive instead.');
  }
  return artifacts;
}

function argumentsFrom(argv) {
  const options = { input: '', key: '', output: '' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!value || !['--input', '--key', '--output'].includes(key)) fail('Usage: node scripts/sign-ota-release.mjs --input DIR --key PRIVATE_KEY [--output DIR]');
    options[key.slice(2)] = value;
  }
  if (!options.input || !options.key) fail('Both --input and --key are required.');
  return options;
}

export async function signRelease({ input, key, output }) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Canonical release version required.');
  input = path.resolve(input); key = path.resolve(key);
  regular(key, 'OTA private key');
  const keySize = fs.statSync(key).size;
  if (keySize < 32 || keySize > 64 * 1024) fail('Unexpected OTA private key size.');
  const artifacts = releaseArtifacts(input);
  output = path.resolve(output || path.join(input, `ota-signed-${version}`));
  if (fs.existsSync(output)) fail(`Fresh output directory required: ${output}`);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });

  const result = { schema: 1, version, signedAt: new Date().toISOString(), artifacts: [] };
  for (const artifact of artifacts) {
    const source = path.join(input, artifact.name);
    regular(source, 'Release artifact');
    const destination = path.join(output, artifact.name);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    await runReviewedTauri([
      'signer', 'sign', '--private-key-path', key,
      '--app-version', version, destination,
    ], 'node scripts/sign-ota-release.mjs');
    const signaturePath = `${destination}.sig`;
    regular(signaturePath, 'OTA signature');
    const bytes = fs.readFileSync(destination);
    const signature = fs.readFileSync(signaturePath, 'utf8');
    verifyRelease(bytes, signature, version, PINNED_PUBLIC_KEY);
    result.artifacts.push({
      file: artifact.name,
      signature: path.basename(signaturePath),
      target: artifact.target,
      otaUpdaterSupported: artifact.ota,
    });
  }
  fs.writeFileSync(path.join(output, 'OTA-SIGNING-RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Verified OTA signatures written to ${output}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  signRelease(argumentsFrom(process.argv.slice(2))).catch(error => {
    console.error(error instanceof Error ? error.message : 'OTA signing failed.');
    process.exitCode = 1;
  });
}
