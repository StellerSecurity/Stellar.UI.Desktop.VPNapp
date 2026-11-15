'use strict';
// First-party, fixed-input tests. No npm CLI, package hooks or external input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

async function main() {
  let assertions = 0;
  assert.throws(() => fs.readFileSync(process.argv[2]), error => ['EPERM', 'EACCES', 'ERR_ACCESS_DENIED'].includes(error.code));
  assertions++;
  await new Promise((resolve, reject) => {
    let socket;
    try { socket = net.connect({ host: '127.0.0.1', port: 9 }); }
    catch (error) {
      if (error.code !== 'ERR_ACCESS_DENIED') return reject(error);
      resolve();
      return;
    }
    socket.setTimeout(500);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('network denial was not established')); });
    socket.on('connect', () => { socket.destroy(); reject(new Error('network access was permitted')); });
    socket.on('error', error => {
      socket.destroy();
      if (!['EPERM', 'EACCES', 'ERR_ACCESS_DENIED'].includes(error.code)) return reject(new Error('network access was not denied by the sandbox'));
      resolve();
    });
  });
  assertions++;
  assert.throws(() => require('node:child_process').spawnSync(process.execPath, ['--version']),
    error => error.code === 'ERR_ACCESS_DENIED');
  assertions++;
  const packages = path.join(__dirname, 'npm/node_modules');
  for (const flavor of ['commonjs', 'esm']) {
    const load = async name => {
      const filename = path.join(packages, name, 'dist', flavor, 'index.js');
      return flavor === 'esm' ? import(pathToFileURL(filename).href) : require(filename);
    };
    const { Minimatch } = await load('minimatch');
    const expanded = new Minimatch(Array(30).fill('**/../a/b').join('/'), {
      optimizationLevel: 2, braceExpandMax: 64,
    });
    assert.equal(expanded.set.length, 64);
    assertions++;
    const benign = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
    assert.equal(benign.set.length, 4);
    assert.equal(benign.match('../a/b/../c/d'), true);
    assert.equal(benign.match('x/a/b/y/c/d'), true);
    assertions += 3;
    const large = Array.from({ length: 1001 }, () => ['x']);
    assert.equal(benign.secondPhasePreProcess(large), large);
    assertions++;
    const { glob } = await load('glob');
    const fixture = path.join(__dirname, 'fixture-' + flavor);
    for (const name of ['a', 'b']) {
      fs.mkdirSync(path.join(fixture, name), { recursive: true });
      fs.writeFileSync(path.join(fixture, name, 'item.txt'), 'fixture');
    }
    assert.deepEqual((await glob('**/*.txt', { cwd: fixture })).sort(), ['a/item.txt', 'b/item.txt']);
    assertions++;
    const controller = new AbortController();
    const stopped = new Error('fixed-input cancellation');
    let reads = 0;
    const countedFs = {
      ...fs,
      readdir(...args) {
        if (++reads === 1) controller.abort(stopped);
        return fs.readdir(...args);
      },
      readdirSync(...args) {
        if (++reads === 1) controller.abort(stopped);
        return fs.readdirSync(...args);
      },
    };
    await assert.rejects(glob('**', { cwd: fixture, signal: controller.signal, fs: countedFs }), error => error === stopped);
    const atCancellation = reads;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(reads, atCancellation);
    assert.equal(reads, 1);
    assertions += 3;
  }
  console.log(JSON.stringify({ assertions, isolation: 'fresh-ephemeral-CI-VM-plus-Node-permissions', permission_file_denial: true, permission_network_denial: true, child_process_denial: true,
    patched_commonjs_and_esm: true, npm_cli_executed: false, hooks_executed: false }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
