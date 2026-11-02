// Generate, never install, the first-party helper package for the drag-install app.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { packageOptions, assertArchitecture, verifyRuntime } from './macos-architecture.mjs';
if (process.platform !== 'darwin') throw new Error('macOS packaging requires macOS');
const { arch, runtime, helper } = packageOptions(process.argv.slice(2));
assertArchitecture(helper, arch);
const manifest = verifyRuntime(runtime, arch);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-network-helper-'));
const root = path.join(stage, 'root/Library/Application Support/Stellar VPN');
const scripts = path.join(stage, 'scripts');
fs.mkdirSync(path.join(root, 'Runtime'), { recursive: true }); fs.mkdirSync(scripts);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const { file, sha256 } of manifest.files) {
  if (!['openvpn','libcrypto.4.dylib','libssl.4.dylib','liblzo2.2.dylib','libpkcs11-helper.1.dylib','liblz4.1.dylib'].includes(file) || hash(path.join(runtime,file)) !== sha256) throw new Error('Runtime integrity mismatch');
  fs.copyFileSync(path.join(runtime,file),path.join(root,'Runtime',file)); fs.chmodSync(path.join(root,'Runtime',file),0o755);
}
fs.copyFileSync(path.join(runtime,'runtime-manifest.json'),path.join(root,'Runtime/runtime-manifest.json'));
for (const [source,destination] of [[helper,'stellar-vpn-helper'],['scripts/macos-helper/uninstall','uninstall-helper']]) {
  fs.copyFileSync(source,path.join(root,destination)); fs.chmodSync(path.join(root,destination),0o755);
}
for (const script of ['preinstall','postinstall']) { fs.copyFileSync('scripts/macos-helper/'+script,path.join(scripts,script)); fs.chmodSync(path.join(scripts,script),0o755); }
const component = path.join(stage,'helper.pkg');
execFileSync('/usr/bin/pkgbuild',['--root',path.join(stage,'root'),'--scripts',scripts,'--identifier','org.stellarvpn.desktop.helper','--version','0.1.0','--ownership','recommended','--install-location','/',component]);
const resources = path.join(stage,'resources'); fs.mkdirSync(resources);
fs.writeFileSync(path.join(resources,'welcome.html'), '<!doctype html><meta charset="utf-8"><h2>Aktivér Stellar VPN</h2><p>Installer netværkshjælperen, så Stellar VPN kan oprette sikre forbindelser.</p><p>macOS beder om administratorgodkendelse. Hjælperen kører i baggrunden. En lokal firewallkontrol kan kort afbryde netværket.</p><p>Vend derefter tilbage til Stellar VPN, og vælg Prøv igen.</p>');
fs.writeFileSync(path.join(resources,'conclusion.html'), '<!doctype html><meta charset="utf-8"><h2>Klar</h2><p>Vend tilbage til Stellar VPN, og vælg Prøv igen.</p>');
fs.writeFileSync(path.join(stage,'Distribution.xml'),`<?xml version="1.0"?><installer-gui-script minSpecVersion="2"><title>Stellar VPN — netværkshjælper</title><options customize="never" hostArchitectures="${arch}"/><domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/><welcome file="welcome.html"/><conclusion file="conclusion.html"/><choices-outline><line choice="main"/></choices-outline><choice id="main" visible="false"><pkg-ref id="org.stellarvpn.desktop.helper"/></choice><pkg-ref id="org.stellarvpn.desktop.helper" version="0.1.0">helper.pkg</pkg-ref></installer-gui-script>`);
const output = path.resolve('src-tauri/resources/NetworkHelper.pkg');
execFileSync('/usr/bin/productbuild',['--distribution',path.join(stage,'Distribution.xml'),'--package-path',stage,'--resources',resources,output]);
fs.writeFileSync('src-tauri/resources/NetworkHelper.sha256',hash(output)+'\n');
fs.writeFileSync('src-tauri/resources/NetworkHelper.arch.json',JSON.stringify({ architecture: arch, packageSha256: hash(output), helperSha256: hash(helper), runtimePlatform: manifest.platform }, null, 2)+'\n');
console.log(`Generated ${arch} helper package; nothing installed.`);
