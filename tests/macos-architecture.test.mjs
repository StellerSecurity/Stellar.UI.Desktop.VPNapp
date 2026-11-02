import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { macArchitecture, rustTarget, binaryArchitectures, assertArchitecture, verifyRuntime, sha256, packageOptions } from '../scripts/macos-architecture.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-architecture-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
}
function binary(file, arch) {
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  fs.writeFileSync(file, header);
}
function runtime(t, arch) {
  const directory = fixture(t);
  const files = ['openvpn','libcrypto.4.dylib','libssl.4.dylib','liblzo2.2.dylib','libpkcs11-helper.1.dylib','liblz4.1.dylib'].map(file => {
    binary(path.join(directory, file), arch); return { file, sha256: sha256(path.join(directory, file)) };
  });
  const manifest = { platform: `darwin-${arch}`, files };
  fs.writeFileSync(path.join(directory, 'runtime-manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}
test('Node and Rust architecture names map explicitly; unknown targets fail closed', () => {
  assert.equal(macArchitecture('x64'), 'x86_64'); assert.equal(rustTarget('x86_64'), 'x86_64-apple-darwin');
  assert.equal(rustTarget('arm64'), 'aarch64-apple-darwin'); assert.throws(() => macArchitecture('universal'));
  assert.throws(() => packageOptions(['--arch', 'intel'])); assert.throws(() => packageOptions(['--profile', 'custom']));
  assert.throws(() => packageOptions(['--runtime'])); assert.throws(() => packageOptions(['--arch','arm64','--arch','x64']));
  assert.match(packageOptions(['--arch','x86_64']).runtime, /openvpn-runtime-x86_64$/);
});
test('Mach-O headers distinguish Intel from ARM without executing code', t => {
  const directory = fixture(t), file = path.join(directory, 'binary');
  binary(file, 'x86_64'); assert.deepEqual(binaryArchitectures(file), ['x86_64']); assertArchitecture(file, 'x64');
  assert.throws(() => assertArchitecture(file, 'arm64'), /mismatch/);
  binary(file, 'arm64'); assert.deepEqual(binaryArchitectures(file), ['arm64']);
  fs.writeFileSync(file, Buffer.alloc(32)); assert.throws(() => binaryArchitectures(file), /Unsupported/);
});
test('binary symlinks and truncated headers are rejected', t => {
  const directory = fixture(t), file = path.join(directory, 'binary'); binary(file, 'arm64');
  fs.symlinkSync(file, path.join(directory, 'link')); assert.throws(() => binaryArchitectures(path.join(directory, 'link')), /regular/);
  fs.writeFileSync(file, Buffer.alloc(2)); assert.throws(() => binaryArchitectures(file), /Invalid/);
});
test('runtime validates all six hashes and rejects cross-architecture packaging', t => {
  const { directory } = runtime(t, 'x86_64'); assert.equal(verifyRuntime(directory, 'x86_64').platform, 'darwin-x86_64');
  assert.throws(() => verifyRuntime(directory, 'arm64'), /Reviewed runtime/);
  binary(path.join(directory, 'libssl.4.dylib'), 'arm64'); assert.throws(() => verifyRuntime(directory, 'x86_64'), /mismatch/);
});
test('duplicate, path-traversal and tampered runtime entries fail closed', t => {
  const { directory, manifest } = runtime(t, 'arm64');
  const write = value => fs.writeFileSync(path.join(directory, 'runtime-manifest.json'), JSON.stringify(value));
  write({ ...manifest, files: Array(6).fill(manifest.files[0]) }); assert.throws(() => verifyRuntime(directory, 'arm64'));
  write({ ...manifest, files: [{ ...manifest.files[0], file: '../openvpn' }, ...manifest.files.slice(1)] }); assert.throws(() => verifyRuntime(directory, 'arm64'));
  write(manifest); fs.appendFileSync(path.join(directory, 'openvpn'), 'changed'); assert.throws(() => verifyRuntime(directory, 'arm64'), /integrity/);
});
