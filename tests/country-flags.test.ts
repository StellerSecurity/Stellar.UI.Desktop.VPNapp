import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../assets/flags/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('provenance.json', root), 'utf8'));
test('flat local flags cover every bundled server and future country examples', () => {
  const codes = new Set(manifest.flags.map((flag: { code: string }) => flag.code.toUpperCase()));
  const servers = JSON.parse(fs.readFileSync(new URL('../assets/servers.json', import.meta.url), 'utf8'));
  for (const server of servers) assert.ok(codes.has(server.country), server.country);
  for (const code of ['DK', 'SE', 'IS', 'NZ', 'BT']) assert.ok(codes.has(code));
  assert.ok(codes.size >= 240);
});
test('bundled flags are static PNGs with recorded hashes, never runtime external URLs', () => {
  for (const flag of manifest.flags) {
    assert.match(flag.code, /^[a-z]{2}$/);
    const bytes = fs.readFileSync(new URL(`${flag.code}.png`, root));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 80);
    assert.equal(bytes.subarray(-8, -4).toString('ascii'), 'IEND');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), flag.sha256);
    assert.equal(flag.source, `https://flagcdn.com/w80/${flag.code}.png`);
  }
});
