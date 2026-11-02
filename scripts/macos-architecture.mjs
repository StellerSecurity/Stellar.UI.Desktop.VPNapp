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
export function minimumMacOS(file) {
  binaryArchitectures(file);
  const data = fs.readFileSync(file);
  const read = data.readUInt32LE(0) === 0xfeedfacf ? offset => data.readUInt32LE(offset) : offset => data.readUInt32BE(offset);
  const count = read(16), bytes = read(20), end = 32 + bytes;
  if (end > data.length || count > bytes / 8) throw new Error('Invalid Mach-O load commands');
  let offset = 32, version;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > end) throw new Error('Truncated Mach-O load command');
    const command = read(offset), size = read(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid Mach-O load command size');
    if (command === 0x32 || command === 0x24) {
      if (version !== undefined || size < (command === 0x32 ? 24 : 16)) throw new Error('Invalid deployment target');
      if (command === 0x32 && read(offset + 8) !== 1) throw new Error('Runtime is not built for macOS');
      version = read(offset + (command === 0x32 ? 12 : 8));
    }
    offset += size;
  }
  if (offset !== end || version === undefined || version === 0) throw new Error('Missing or invalid macOS deployment target');
  return [version >>> 16, (version >>> 8) & 255, version & 255].join('.');
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
    const minimum = minimumMacOS(file);
    const [major, minor, patch] = minimum.split('.').map(Number);
    if (major > 12 || (major === 12 && (minor > 0 || patch > 0))) throw new Error(`Runtime requires macOS ${minimum}, exceeding app minimum 12.0: ${row.file}`);
    if (row.minimumMacOS !== undefined && row.minimumMacOS !== minimum) throw new Error(`Runtime deployment target metadata mismatch: ${row.file}`);
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
