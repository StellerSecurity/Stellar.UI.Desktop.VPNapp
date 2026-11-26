import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'release', 'frontend-manifest.json');
const dist = path.join(root, 'dist');
const inputs = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function walk(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const target = path.join(directory, entry.name);
    const metadata = fs.lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error(`Release frontend contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) result.push(...walk(target, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Release frontend contains a non-regular entry: ${relative}`);
  }
  return result.sort();
}

function sourceDigest() {
  const files = walk(path.join(root, 'src'), 'src');
  for (const relative of inputs) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) files.push(relative);
  }
  files.sort();
  const digest = createHash('sha256');
  for (const relative of files) {
    digest.update(relative + '\0');
    digest.update(fs.readFileSync(path.join(root, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function verifyReleaseFrontend() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || typeof manifest.input_sha256 !== 'string' || !manifest.files) {
    throw new Error('Invalid release frontend manifest.');
  }
  if (sourceDigest() !== manifest.input_sha256) throw new Error('Release frontend is stale for the tracked source inputs.');
  const actual = walk(dist);
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release frontend file set does not match its manifest.');
  for (const relative of expected) {
    if (sha256(fs.readFileSync(path.join(dist, relative))) !== manifest.files[relative]) {
      throw new Error(`Release frontend hash mismatch: ${relative}`);
    }
  }
  return { files: expected.length, input_sha256: manifest.input_sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyReleaseFrontend();
  console.log(`Verified ${result.files} release frontend files for ${result.input_sha256}.`);
}
