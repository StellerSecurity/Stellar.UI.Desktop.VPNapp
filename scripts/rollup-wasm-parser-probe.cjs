'use strict';

// Fixed synthetic parser inputs only. No bundling, plugins or application code.
const assert = require('node:assert/strict');
const { parseAst, parseAstAsync } = require('./rollup/dist/parseAst.js');
const native = require('./rollup/dist/native.js');

async function main() {
  const ast = parseAst('export const answer = 42;');
  assert.equal(ast.type, 'Program');
  assert.equal(ast.body[0].type, 'ExportNamedDeclaration');
  assert.equal(ast.body[0].declaration.declarations[0].init.value, 42);
  const unicode = parseAst('const title = "Stellar 🌍";');
  assert.equal(unicode.body[0].declarations[0].init.value, 'Stellar 🌍');
  assert.equal(parseAst('const item = <div />;', { jsx: true }).body[0].declarations[0].init.type, 'JSXElement');
  assert.throws(() => parseAst('const ='), /Unexpected token/);
  assert.throws(() => parseAst('return 1;'), /Return statement/);
  assert.equal(parseAst('return 1;', { allowReturnOutsideFunction: true }).body[0].type, 'ReturnStatement');
  assert.deepEqual(await parseAstAsync('export const answer = 42;'), ast);
  await assert.rejects(parseAstAsync('const ='), /Unexpected token/);
  const input = new Uint8Array([1, 2, 3]);
  const hash = native.xxhashBase16(input);
  assert.match(hash, /^[a-f0-9]{32}$/);
  assert.equal(native.xxhashBase16(input), hash);
  assert.notEqual(native.xxhashBase16(new Uint8Array([1, 2, 4])), hash);
  assert.match(native.xxhashBase36(input), /^[a-z0-9]+$/);
  assert.match(native.xxhashBase64Url(input), /^[a-zA-Z0-9_-]+$/);
  assert.throws(() => new WebAssembly.Memory({ initial: 18 }).grow(65), RangeError);
  console.log(JSON.stringify({ assertions: 16, parser_sync_async: true,
    unicode_jsx_errors_return_options: true, deterministic_hashes: true,
    wasm_memory_cap_pages: 64, oversize_memory_growth_rejected: true,
    target_executed: true, synthetic_inputs_only: true, network_allowed: false,
    app_changed: false, release_approved: false }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
