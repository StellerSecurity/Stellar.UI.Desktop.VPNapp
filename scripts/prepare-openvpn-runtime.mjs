// Explicitly invoked release preparation. These exact bottles were reviewed and approved 2026-10-28.
// Never invoked automatically by npm install, cargo, Vite or ordinary app startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Only the reviewed macOS arm64 runtime is prepared by this script.');
const packages = [
  { name: 'openvpn', version: '2.7.8_1', registry: 'openvpn', sha256: 'e64da55e9cb2b051ed1b7b57bf9069c66b7b112a52d5689adcac9010b25f4e65' },
  { name: 'openssl@4', version: '4.1.0', registry: 'openssl/4', sha256: 'd239639f77a275caa217707e126790b3f5f5c86e5bc6e2a996e5df7fdaed44a6' },
  { name: 'lzo', version: '2.10', registry: 'lzo', sha256: '928ed0070e25fe8082e24daa3f967657be0c1c5c72c14a3ac4cd498874eeec11' },
  { name: 'pkcs11-helper', version: '1.31.0_1', registry: 'pkcs11-helper', sha256: '5831ccf7599dce283920c440b34cc86d5e2f121a77c089bba18e77c040b884ea' },
];
const temporary = process.argv[2] ? await fs.realpath(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-reviewed-openvpn-'));
const destination = path.resolve('src-tauri/resources/openvpn-runtime');
await fs.mkdir(destination, { recursive: true });
async function bottle(pkg) {
  const archive = path.join(temporary, `${pkg.name}.tar.gz`);
  let data;
  try { data = await fs.readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!data) {
  const url = `https://ghcr.io/v2/homebrew/core/${pkg.registry}/blobs/sha256:${pkg.sha256}`;
  let response = await fetch(url);
  if (response.status === 401) {
    const registry = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/${pkg.registry}:pull`);
    const auth = await registry.json();
    if (!registry.ok || typeof auth.token !== 'string') throw Error('Public bottle registry unavailable');
    response = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
  }
  if (!response.ok) throw Error(`Approved bottle unavailable: ${pkg.name}`);
  data = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== pkg.sha256) throw Error(`Checksum failure: ${pkg.name}`);
  await fs.writeFile(archive, data, { flag: 'wx' });
  }
  if (crypto.createHash('sha256').update(data).digest('hex') !== pkg.sha256) throw Error(`Cached bottle checksum failure: ${pkg.name}`);
  const members = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (members.some(member => member.startsWith('/') || member.split('/').includes('..') || !member.startsWith(pkg.name + '/'))) throw Error('Unsafe bottle paths');
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
  console.log(`Verified ${pkg.name} ${pkg.version}`);
  return path.join(temporary, pkg.name, pkg.version);
}
const roots = new Map();
for (const pkg of packages) roots.set(pkg.name, await bottle(pkg));
const binary = path.join(roots.get('openvpn'), 'sbin/openvpn');
const files = [{ from: binary, name: 'openvpn' }];
for (const name of ['openssl@4', 'lzo', 'pkcs11-helper']) {
  const lib = path.join(roots.get(name), 'lib');
  for (const entry of await fs.readdir(lib, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.dylib')) files.push({ from: path.join(lib, entry.name), name: entry.name });
  }
}
// Existing approved lz4 1.10.0; no package installation or version substitution.
files.push({ from: '/opt/homebrew/Cellar/lz4/1.10.0/lib/liblz4.1.10.0.dylib', name: 'liblz4.1.dylib' });
for (const file of files) {
  await fs.copyFile(file.from, path.join(destination, file.name));
  await fs.chmod(path.join(destination, file.name), file.name === 'openvpn' ? 0o755 : 0o644);
}
const aliases = new Map();
for (const file of files) {
  const full = path.join(destination, file.name);
  const headers = execFileSync('/usr/bin/otool', ['-L', full], { encoding: 'utf8' });
  const own = file.name.startsWith('lib') ? execFileSync('/usr/bin/otool', ['-D', full], { encoding: 'utf8' }).trim().split('\n')[1] : null;
  if (own) aliases.set(own.trim(), file.name);
  for (const line of headers.split('\n').slice(1)) {
    const dependency = line.trim().split(' ')[0];
    if (!dependency.startsWith('/opt/homebrew/') && !dependency.startsWith('@@HOMEBREW_PREFIX@@/') && !dependency.startsWith('@@HOMEBREW_CELLAR@@/')) continue;
    const base = path.basename(dependency);
    if (base.startsWith('liblz4.')) aliases.set(dependency, 'liblz4.1.dylib');
    else if (files.some(item => item.name === base)) aliases.set(dependency, base);
    else {
      // Versioned dylib aliases in bottles refer to the same real library file.
      const real = await fs.realpath(path.join(roots.get(dependency.includes('openssl') ? 'openssl@4' : dependency.includes('pkcs11') ? 'pkcs11-helper' : 'lzo'), 'lib', base));
      const name = path.basename(real);
      if (!files.some(item => item.name === name)) throw Error(`Unreviewed dynamic dependency: ${base}`);
      aliases.set(dependency, name);
    }
  }
}
for (const file of files) {
  const full = path.join(destination, file.name);
  const linked = execFileSync('/usr/bin/otool', ['-L', full], { encoding: 'utf8' });
  for (const [old, name] of aliases) if (linked.includes(old)) execFileSync('/usr/bin/install_name_tool', ['-change', old, `@loader_path/${name}`, full]);
  if (file.name.startsWith('lib')) execFileSync('/usr/bin/install_name_tool', ['-id', `@loader_path/${file.name}`, full]);
  const after = execFileSync('/usr/bin/otool', ['-L', full], { encoding: 'utf8' });
  if (after.includes('/opt/homebrew/') || after.includes('@@HOMEBREW')) throw Error('Runtime still requires a Homebrew installation');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', full], { stdio: 'pipe' });
}
const manifest = [];
for (const file of files) manifest.push({ file: file.name, sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(destination, file.name))).digest('hex') });
await fs.writeFile(path.join(destination, 'runtime-manifest.json'), JSON.stringify({ platform: 'darwin-arm64', packages, files: manifest }, null, 2) + '\n');
// Only now execute the reviewed runtime, after all source and output checks.
console.log(execFileSync(path.join(destination, 'openvpn'), ['--version'], { encoding: 'utf8' }).split('\n').slice(0, 2).join('\n'));
console.log('Prepared app-local runtime; no Homebrew installation, system service or privileged helper was installed.');
