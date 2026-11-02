// Inspect binary headers as data. Never execute the binary being inspected.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function macArchitecture(value) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'x86_64') return 'x86_64';
  throw new Error(`Unsupported macOS architecture: ${value}`);
}
export const rustTarget = value => `${macArchitecture(value) === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
export function binaryArchitectures(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular binary: ${file}`);
  const data = fs.readFileSync(file);
  if (data.length < 32) throw new Error(`Invalid Mach-O binary: ${file}`);
  const names = cpu => cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x86_64' : null;
  // Packaging deliberately requires thin slices: universal helpers need their own reviewed runtime strategy.
  const magic = data.readUInt32LE(0);
  const cpu = magic === 0xfeedfacf ? data.readUInt32LE(4) : magic === 0xcffaedfe ? data.readUInt32BE(4) : 0;
  const arch = names(cpu);
  if (!arch) throw new Error(`Unsupported or universal Mach-O binary: ${file}`);
  return [arch];
}
export function assertArchitecture(file, arch) {
  if (!binaryArchitectures(file).includes(macArchitecture(arch))) throw new Error(`Architecture mismatch (${arch} required): ${file}`);
}
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function verifyRuntime(directory, arch) {
  const platform = `darwin-${macArchitecture(arch)}`;
  const manifestFile = path.join(directory, 'runtime-manifest.json');
  if (!fs.lstatSync(manifestFile).isFile()) throw new Error('Runtime manifest is not a regular file');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const expected = ['openvpn', 'libcrypto.4.dylib', 'libssl.4.dylib', 'liblzo2.2.dylib', 'libpkcs11-helper.1.dylib', 'liblz4.1.dylib'];
  if (manifest.platform !== platform || !Array.isArray(manifest.files) || manifest.files.length !== expected.length
    || new Set(manifest.files.map(row => row.file)).size !== expected.length) throw new Error(`Reviewed runtime required for ${platform}`);
  for (const row of manifest.files) {
    if (!expected.includes(row.file) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid runtime manifest entry');
    const file = path.join(directory, row.file);
    assertArchitecture(file, arch);
    if (sha256(file) !== row.sha256) throw new Error(`Runtime integrity mismatch: ${row.file}`);
  }
  return manifest;
}
export function packageOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--arch', '--runtime', '--helper', '--profile'].includes(name) || !args[i + 1] || options[name.slice(2)]) throw new Error(`Invalid packaging option: ${name}`);
    options[name.slice(2)] = args[i + 1];
  }
  const arch = macArchitecture(options.arch || process.arch);
  const profile = options.profile || 'debug';
  if (!['debug', 'release'].includes(profile)) throw new Error('Unsupported build profile');
  return { arch, profile,
    helper: path.resolve(options.helper || (arch === macArchitecture(process.arch) ? `target/${profile}/stellar-vpn-helper` : `target/${rustTarget(arch)}/${profile}/stellar-vpn-helper`)),
    runtime: path.resolve(options.runtime || (arch === 'arm64' ? 'src-tauri/resources/openvpn-runtime' : 'src-tauri/resources/openvpn-runtime-x86_64')) };
}
