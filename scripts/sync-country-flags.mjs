// Static public-domain raster artwork only. No package installation or runtime CDN.
// Source/usage: https://flagpedia.net/download/api and /download (public domain).
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const origin = 'https://flagcdn.com';
async function read(url, type, limit) {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.headers.get('content-type')?.includes(type)) throw Error(`Unexpected asset response: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw Error('Oversized flag asset');
  return bytes;
}
function validatePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Not a PNG');
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > 32768 || offset + length + 12 > bytes.length) throw Error('Invalid PNG chunk');
    if (offset === 8 && (type !== 'IHDR' || length !== 13 || bytes.readUInt32BE(16) !== 80 || bytes.readUInt32BE(20) > 160)) throw Error('Unexpected flag dimensions');
    // Reject text, application payloads and animation; these files are pixels only.
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'bKGD'].includes(type)) throw Error(`Unexpected PNG chunk: ${type}`);
    offset += length + 12;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) throw Error('Invalid PNG ending');
}
const codes = Object.keys(JSON.parse((await read(`${origin}/en/codes.json`, 'application/json', 65536)).toString('utf8'))).filter(code => /^[a-z]{2}$/.test(code)).sort();
if (codes.length < 240 || codes.length > 300) throw Error('Unexpected country inventory');
await fs.mkdir('assets/flags', { recursive: true });
const manifest = [];
let index = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const code = codes[index++]; if (!code) return;
    const url = `${origin}/w80/${code}.png`, bytes = await read(url, 'image/png', 32768);
    validatePng(bytes);
    await fs.writeFile(`assets/flags/${code}.png`, bytes);
    manifest.push({ code, source: url, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}));
manifest.sort((a, b) => a.code.localeCompare(b.code));
await fs.writeFile('assets/flags/provenance.json', JSON.stringify({ source: 'https://flagpedia.net/download', license: 'Public domain', format: 'Flat PNG, width 80px; no executable content', flags: manifest }, null, 2) + '\n');
console.log(`${manifest.length} flat PNG flags validated and bundled; no dependencies installed.`);
