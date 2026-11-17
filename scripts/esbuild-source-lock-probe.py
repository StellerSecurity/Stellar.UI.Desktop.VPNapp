"""Validate only the frozen esbuild candidate's npm lock graph in isolated CI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent
PACKAGE_SHA = 'cc14d9dfd942d17ff05eacb9ca43571806ced7c807126dddb777280260452458'
LOCK_SHA = '68403a0fd33ecc30c55bce87b9c8898fb79ade8dc115fe53cb3fe91a877f13b2'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_graph(before, after):
    if before.get('lockfileVersion') != 3 or after.get('lockfileVersion') != 3:
        raise ValueError('exact npm v3 lock graphs required')
    original, current = before['packages'], after['packages']
    platform = lambda name: name.startswith('node_modules/@esbuild/')
    others = {name: value for name, value in original.items()
              if name not in ('', 'node_modules/esbuild') and not platform(name)}
    if any(current.get(name) != value for name, value in others.items()):
        raise ValueError('npm changed unrelated locked dependency metadata')
    expected = set(others) | {'', 'node_modules/esbuild', 'vendor/esbuild-reviewed'}
    if set(current) != expected or any(platform(name) for name in current):
        raise ValueError('npm source graph contains unexpected dependencies or platform binaries')
    if current['node_modules/esbuild'] != dict(resolved='vendor/esbuild-reviewed', link=True):
        raise ValueError('esbuild must resolve only to the contained source candidate')
    fork = current['vendor/esbuild-reviewed']
    if fork.get('version') != '0.28.1-stellar.1' or any(key in fork for key in ('dependencies', 'optionalDependencies', 'hasInstallScript')):
        raise ValueError('local esbuild candidate acquired runtime dependencies or hooks')
    root = dict(original[''])
    root['devDependencies'] = dict(root.get('devDependencies', {}), esbuild='file:vendor/esbuild-reviewed')
    if current[''] != root:
        raise ValueError('unexpected root dependency changes')
    return dict(unrelated_locked_dependencies_unchanged=len(others),
                removed_platform_packages=sum(platform(name) for name in original),
                only_contained_esbuild_source=True, package_graph_complete=True)


def main():
    tool = load('reviewed_tool', 'linux-npm-backport-probe.py')
    fork = load('reviewed_fork', 'stage-reviewed-esbuild-fork.py')
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('fresh isolated Linux CI VM required')
    package = tool.verified(ROOT / 'application-package.json', PACKAGE_SHA)
    lock = tool.verified(ROOT / 'application-package-lock.json', LOCK_SHA)
    npm = tool.download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', tool.NPM_SHA, 8 * 1024**2)
    node = tool.download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', tool.NODE_ARCHIVE_SHA, 64 * 1024**2)
    source = tool.download('https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz', fork.ARCHIVE_SHA, 4 * 1024**2)
    tool.verified(ROOT / 'patch-reviewed-npm-tool.py', tool.PATCH_SHA)
    patcher = load('reviewed_tool_patch', 'patch-reviewed-npm-tool.py')
    with tempfile.TemporaryDirectory(prefix='stellar-esbuild-lock-', dir=ROOT) as directory:
        work = Path(directory).resolve()
        (work / 'tmp').mkdir()
        (work / 'config').mkdir()
        (work / 'config/user.npmrc').write_text('')
        (work / 'config/global.npmrc').write_text('')
        project = work / 'project'
        project.mkdir()
        records, patches, executable = tool.materialize_runtime(work, npm, node, patcher)
        candidate = project / 'vendor/esbuild-reviewed'
        source_identity = fork.stage(source, ROOT, candidate)
        manifest = json.loads(package)
        manifest.setdefault('devDependencies', {})['esbuild'] = 'file:vendor/esbuild-reviewed'
        manifest.setdefault('overrides', {})['esbuild'] = '$esbuild'
        (project / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (project / 'package-lock.json').write_bytes(lock)
        env = dict(PATH='/usr/bin:/bin', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC',
                   NPM_CONFIG_UPDATE_NOTIFIER='false', NPM_CONFIG_CACHE=str(work / 'cache'))
        command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                   '--allow-fs-write=' + str(work), '--no-addons', '--disable-sigusr1',
                   '--max-old-space-size=256', str(work / 'npm/bin/npm-cli.js'), 'install',
                   '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
                   '--include=dev', '--include=optional', '--prefix=' + str(project),
                   '--cache=' + str(work / 'cache'), '--userconfig=' + str(work / 'config/user.npmrc'),
                   '--globalconfig=' + str(work / 'config/global.npmrc')]
        output = tool.run(command, project, env, 45)
        generated = (project / 'package-lock.json').read_bytes()
        if len(generated) > 2 * 1024**2:
            raise ValueError('generated source lock byte limit')
        after = json.loads(generated)
        checked = validate_graph(json.loads(lock), after)
        for name, expected in records.items():
            tool.verified(work / 'npm' / name, expected)
        for name, expected in source_identity['files_sha256'].items():
            tool.verified(candidate / name, expected)
        if (project / 'node_modules').exists():
            raise ValueError('metadata-only validation installed node_modules')
        print(json.dumps(dict(schema=1, result=checked, source_identity=source_identity,
                              npm_cli_frozen_graph_only=True, npm_output=output,
                              package_manifest=manifest, generated_lock=after,
                              source_fork_api_executed=False, hooks_executed=False,
                              node_modules_installed=False, unchanged_tool_source_files=len(records),
                              original_application_changed=False,
                              scanner_integration_complete=False, release_approved=False)))


if __name__ == '__main__':
    main()
