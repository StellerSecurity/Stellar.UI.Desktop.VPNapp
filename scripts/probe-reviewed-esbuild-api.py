"""Fixed source-fork API probes against the exact rebuilt Linux binary only."""
import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe(target, work):
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('fresh Linux CI VM required')
    tool = load('reviewed_node_tool', 'linux-npm-backport-probe.py')
    fork = load('reviewed_source_fork', 'stage-reviewed-esbuild-fork.py')
    tool.verified(target, '0ec4b4dc642d8786c75ea26419100ac291af95ab1b831e559d1ed62fa6b7cd96')
    tool.verified(ROOT / 'patch-reviewed-npm-tool.py', tool.PATCH_SHA)
    patcher = load('reviewed_npm_source_patch', 'patch-reviewed-npm-tool.py')
    npm = tool.download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', tool.NPM_SHA, 8 * 1024**2)
    node = tool.download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', tool.NODE_ARCHIVE_SHA, 64 * 1024**2)
    archive = tool.download('https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz', fork.ARCHIVE_SHA, 4 * 1024**2)
    runtime = work / 'api-probe'
    runtime.mkdir()
    records, patches, executable = tool.materialize_runtime(runtime, npm, node, patcher)
    source = runtime / 'esbuild-reviewed'
    identity = fork.stage(archive, ROOT, source)
    # First-party fixture setup creates this owned alias. The Node process keeps
    # its scoped filesystem permissions and is not allowed to create symlinks.
    (runtime / 'runtime-alias').symlink_to(target)
    fixture = runtime / 'probe.cjs'
    fixture.write_text("""'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./esbuild-reviewed/lib/reviewed-binary.cjs');
const original = process.env.ESBUILD_BINARY_PATH;
for (const candidate of ['', 'relative-path']) {
  process.env.ESBUILD_BINARY_PATH = candidate;
  assert.throws(guard, /absolute path/);
}
const changed = path.join(__dirname, 'changed-runtime');
const bytes = fs.readFileSync(original);
bytes[bytes.length - 1] ^= 1;
fs.writeFileSync(changed, bytes);
process.env.ESBUILD_BINARY_PATH = changed;
assert.throws(guard, /does not match/);
const alias = path.join(__dirname, 'runtime-alias');
process.env.ESBUILD_BINARY_PATH = alias;
assert.throws(guard, /regular file/);
process.env.ESBUILD_BINARY_PATH = original;
assert.equal(guard(), original);
const api = require('./esbuild-reviewed/lib/main.js');
assert.equal(api.version, '0.28.1');
assert.equal(api.transformSync('console.log(1 + 2);', {minify: true}).code, 'console.log(3);\\n');
assert.equal(api.transformSync('const answer: number = 42;', {loader: 'ts', minify: true}).code, 'const answer=42;\\n');
assert.throws(() => api.transformSync('const =', {loader: 'js', logLevel: 'silent'}));
(async () => {
  const transformed = await api.transform('console.log(20 + 22);', {minify: true});
  assert.equal(transformed.code, 'console.log(42);\\n');
  const built = await api.build({stdin: {contents: 'export const answer = 40 + 2;', resolveDir: __dirname},
                               bundle: true, write: false, format: 'esm', minify: true});
  assert.equal(built.outputFiles.length, 1);
  assert.match(built.outputFiles[0].text, /=42/);
  assert.match(built.outputFiles[0].text, /export/);
  await assert.rejects(api.transform('const =', {loader: 'js', logLevel: 'silent'}));
  api.stop();
  console.log(JSON.stringify({assertions: 14, sync: true, async: true,
                             invalid_runtime_rejected_before_execution: true, build_write: false}));
})().catch(error => { api.stop(); console.error(error); process.exitCode = 1; });
""")
    env = dict(PATH='/usr/bin:/bin', TMPDIR=str(runtime), LANG='C.UTF-8', TZ='UTC',
               ESBUILD_BINARY_PATH=str(target))
    command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
               '--allow-fs-write=' + str(work), '--allow-child-process', '--no-addons',
               '--disable-sigusr1', '--max-old-space-size=256', str(fixture)]
    output = tool.run(command, runtime, env, 45)
    for name, expected in records.items():
        tool.verified(runtime / 'npm' / name, expected)
    for name, expected in identity['files_sha256'].items():
        tool.verified(source / name, expected)
    tool.verified(target, '0ec4b4dc642d8786c75ea26419100ac291af95ab1b831e559d1ed62fa6b7cd96')
    result = json.loads(output.splitlines()[-1])
    if result != {'assertions': 14, 'sync': True, 'async': True, 'invalid_runtime_rejected_before_execution': True, 'build_write': False}:
        raise ValueError('fixed API probe result drift')
    return dict(result=result, source_identity=identity, tool_sources_unchanged=len(records),
                child_execution_scope='Exact rebuilt Linux x64 esbuild; invalid copies are never executed.',
                isolation='Ephemeral CI VM; Node permission model is not a malicious-code OS sandbox.',
                hooks_executed=False, npm_cli_executed=False, application_executed=False, release_approved=False)
