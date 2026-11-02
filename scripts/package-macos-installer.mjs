// First-party packaging only: no download, installation, signature or notarisation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This local installer supports macOS ARM64 only.');
const app = path.resolve('target/debug/bundle/macos/Stellar VPN.app');
const helper = path.resolve('target/debug/stellar-vpn-helper');
const runtime = path.resolve('src-tauri/resources/openvpn-runtime');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
const binaries = ['openvpn', 'libcrypto.4.dylib', 'libssl.4.dylib', 'liblzo2.2.dylib', 'libpkcs11-helper.1.dylib', 'liblz4.1.dylib'];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function regular(file) { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe input file: ${file}`); }
regular(helper); regular(path.join(app, 'Contents/Info.plist')); regular(path.join(app, 'Contents/MacOS/stellar-vpn-desktop'));
const identifier = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (identifier !== 'org.stellarsecurity.vpn.desktop') throw new Error('Unexpected application identity');
if (manifest.platform !== 'darwin-arm64' || manifest.files.length !== binaries.length) throw new Error('Unexpected reviewed runtime');
for (const file of binaries) { regular(path.join(runtime, file)); if (hash(path.join(runtime, file)) !== manifest.files.find(row => row.file === file)?.sha256) throw new Error(`Runtime integrity mismatch: ${file}`); }
// Only self-contained app files. Never follow source symlinks outside the bundle.
function validateTree(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
  if (item.isSymbolicLink()) throw new Error(`Unexpected app symlink: ${item.name}`);
  if (item.isDirectory()) validateTree(path.join(directory, item.name));
} }
validateTree(app);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-complete-installer-'));
fs.mkdirSync('build/installers', { recursive: true });
const output = fs.mkdtempSync(path.resolve('build/installers/stellar-macos-'));
const root = path.join(stage, 'root'), support = path.join(root, 'Library/Application Support/Stellar VPN');
fs.mkdirSync(path.join(root, 'Applications'), { recursive: true });
fs.cpSync(app, path.join(root, 'Applications/Stellar VPN.app'), { recursive: true, dereference: false });
fs.mkdirSync(path.join(support, 'Runtime'), { recursive: true });
function copy(input, destination, mode = 0o755) { regular(input); fs.copyFileSync(input, destination); fs.chmodSync(destination, mode); }
copy(helper, path.join(support, 'stellar-vpn-helper'));
copy('scripts/macos-helper/uninstall', path.join(support, 'uninstall-helper'));
for (const file of [...binaries, 'runtime-manifest.json']) copy(path.join(runtime, file), path.join(support, 'Runtime', file), file.endsWith('.json') ? 0o644 : 0o755);
const scripts = path.join(stage, 'scripts'); fs.mkdirSync(scripts);
for (const file of ['preinstall', 'postinstall']) {
  copy(`scripts/macos-installer/${file}`, path.join(scripts, file));
  copy(`scripts/macos-helper/${file}`, path.join(scripts, `helper-${file}`));
}
const component = path.join(stage, 'Stellar-VPN-Component.pkg');
const components = path.join(stage, 'components.plist');
execFileSync('/usr/bin/pkgbuild', ['--analyze', '--root', root, components]);
const data = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', components], { encoding: 'utf8' }));
for (const bundle of data) bundle.BundleIsRelocatable = false;
fs.writeFileSync(path.join(stage, 'components.json'), JSON.stringify(data));
execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', components, path.join(stage, 'components.json')]);
execFileSync('/usr/bin/pkgbuild', ['--root', root, '--component-plist', components, '--scripts', scripts, '--identifier', 'org.stellarvpn.desktop.installer', '--version', version, '--ownership', 'recommended', '--install-location', '/', component]);
function distribution(title, packageFile, packageId, welcome, conclusion = 'conclusion.html') {
  return `<?xml version="1.0" encoding="utf-8"?><installer-gui-script minSpecVersion="2"><title>${title}</title><options customize="never" hostArchitectures="arm64"/><domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/><welcome file="${welcome}"/><conclusion file="${conclusion}"/><choices-outline><line choice="main"/></choices-outline><choice id="main" visible="false"><pkg-ref id="${packageId}"/></choice><pkg-ref id="${packageId}" version="${version}">${packageFile}</pkg-ref></installer-gui-script>`;
}
const resources = path.resolve('scripts/macos-installer');
const installer = path.join(output, `Stellar-VPN-${version}-macos-arm64-unsigned.pkg`);
fs.writeFileSync(path.join(stage, 'Distribution.xml'), distribution('Stellar VPN', path.basename(component), 'org.stellarvpn.desktop.installer', 'welcome.html'));
execFileSync('/usr/bin/productbuild', ['--distribution', path.join(stage, 'Distribution.xml'), '--package-path', stage, '--resources', resources, installer]);
const removalScripts = path.join(stage, 'removal-scripts'); fs.mkdirSync(removalScripts);
copy('scripts/macos-installer/uninstall-preinstall', path.join(removalScripts, 'preinstall'));
const removalComponent = path.join(stage, 'Stellar-VPN-Removal-Component.pkg');
execFileSync('/usr/bin/pkgbuild', ['--nopayload', '--scripts', removalScripts, '--identifier', 'org.stellarvpn.desktop.uninstall', '--version', version, removalComponent]);
const uninstaller = path.join(output, `Stellar-VPN-Uninstall-${version}-macos-arm64-unsigned.pkg`);
fs.writeFileSync(path.join(stage, 'Removal.xml'), distribution('Uninstall Stellar VPN', path.basename(removalComponent), 'org.stellarvpn.desktop.uninstall', 'uninstall-welcome.html', 'uninstall-conclusion.html'));
execFileSync('/usr/bin/productbuild', ['--distribution', path.join(stage, 'Removal.xml'), '--package-path', stage, '--resources', resources, uninstaller]);
const result = { installer, uninstaller, version, platform: 'macos-arm64', signed: false, notarised: false, installed: false, appIdentifier: identifier,
  sha256: { installer: hash(installer), uninstaller: hash(uninstaller), helper: hash(helper), app: hash(path.join(app, 'Contents/MacOS/stellar-vpn-desktop')) },
  warning: 'Local development packages only. Public distribution requires signing, notarisation and a clean-machine install/uninstall test.' };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
