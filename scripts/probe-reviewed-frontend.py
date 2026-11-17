"""Compile immutable frontend sources with reviewed, bounded build tools only."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def stage(raw, destination, expected_prefix):
    """Stage exact already reviewed members as files, without extraction APIs."""
    records, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            if member.isdir():
                continue
            parts = PurePosixPath(member.name).parts
            if (not member.isfile() or not parts or parts[0] != expected_prefix
                    or member.name.startswith('/') or '\\' in member.name
                    or '..' in parts or not 0 <= member.size <= 16 * 1024**2):
                raise ValueError('uncontained reviewed frontend source member')
            name = '/'.join(parts[1:])
            total += member.size
            if not name or name in records or len(records) >= 10000 or total > 128 * 1024**2:
                raise ValueError('frontend source archive bounds')
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError('frontend source member length')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(data)
            records[str(target)] = hashlib.sha256(data).hexdigest()
    return records


def probe(exported_binary, work):
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('fresh reviewed Linux CI only')
    plan = json.loads((ROOT / 'frontend-build-plan.json').read_text())
    if (plan['application_commit'] != '3a4801a0cc384f0626f9f08660626f7ff85bed05'
            or plan['application_repository'] != 'StellerSecurity/Stellar.UI.Desktop.VPNapp'
            or len(plan['application_files']) != 380 or len(plan['source_packages']) != 17):
        raise ValueError('fixed current PR13 frontend input closure required')
    tool = load('reviewed_node_tool', 'linux-npm-backport-probe.py')
    fork = load('reviewed_esbuild_source', 'stage-reviewed-esbuild-fork.py')
    patcher = load('reviewed_npm_patcher', 'patch-reviewed-npm-tool.py')
    tool.verified(exported_binary, plan['esbuild_linux_sha256'])
    scope = work / 'frontend-probe'
    scope.mkdir()
    (scope / 'tmp').mkdir()
    npm = tool.download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', tool.NPM_SHA, 8 * 1024**2)
    node = tool.download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', tool.NODE_ARCHIVE_SHA, 64 * 1024**2)
    runtime_sources, _, executable = tool.materialize_runtime(scope, npm, node, patcher)
    binary = scope / 'reviewed-esbuild'
    binary.write_bytes(tool.verified(exported_binary, plan['esbuild_linux_sha256']))
    binary.chmod(0o700)
    snapshots = {str(binary): plan['esbuild_linux_sha256']}
    workspace_fixture = scope / 'package.json'
    workspace_fixture.write_text('{"name":"stellar-reviewed-frontend-workspace","private":true,"workspaces":["project"]}\n')
    snapshots[str(workspace_fixture)] = hashlib.sha256(workspace_fixture.read_bytes()).hexdigest()
    project = scope / 'project'
    project.mkdir()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), tool.NoRedirect())
    def application_input(item):
        name, identity = item
        if (not (name.startswith(('src/', 'assets/')) or name in (
                'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'stellar-tokens.css', 'vpn.css'))
                or '..' in PurePosixPath(name).parts or '\\' in name or name.endswith(('.md', '.env'))):
            raise ValueError('unreviewed application input path')
        url = 'https://raw.githubusercontent.com/' + plan['application_repository'] + '/' + plan['application_commit'] + '/' + name
        with opener.open(url, timeout=30) as response:
            raw = response.read(identity['bytes'] + 1)
            if response.geturl() != url or len(raw) != identity['bytes'] or hashlib.sha256(raw).hexdigest() != identity['sha256']:
                raise ValueError('immutable first-party frontend source drift')
        path = project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(raw)
        return str(path), identity['sha256']
    with ThreadPoolExecutor(max_workers=4) as executor:
        snapshots.update(dict(executor.map(application_input, plan['application_files'].items())))
    # The actual project declares no PostCSS plugins. Bound this synthetic
    # runtime view to an explicit empty fixture so lilconfig never searches
    # unrelated runner/home/ancestor configuration. Application files stay exact.
    css_fixture = project / '.postcssrc.json'
    css_fixture.write_text('{"plugins":{}}\n')
    snapshots[str(css_fixture)] = hashlib.sha256(css_fixture.read_bytes()).hexdigest()
    def dependency(row):
        name = row['name']
        if name in ('vite',) and row['version'] != '7.3.8':
            raise ValueError('vulnerable Vite execution forbidden')
        if row['location'] != 'node_modules/' + name or not row['url'].startswith('https://registry.npmjs.org/'):
            raise ValueError('reviewed contained registry source only')
        raw = tool.download(row['url'], row['archive_sha256'], row['archive_bytes'])
        if len(raw) != row['archive_bytes']:
            raise ValueError('reviewed source archive size drift')
        prefix = name.removeprefix('@types/') if name.startswith('@types/') else 'package'
        destination = project / row['location']
        records = stage(raw, destination, prefix)
        manifest = json.loads((destination / 'package.json').read_text())
        if manifest['name'] != name or manifest['version'] != row['version']:
            raise ValueError('source manifest identity drift')
        if any(key in manifest.get('scripts', {}) for key in ('preinstall', 'install', 'postinstall', 'prepare')):
            raise ValueError('reviewed frontend view acquired lifecycle hook')
        return records
    with ThreadPoolExecutor(max_workers=4) as executor:
        for records in executor.map(dependency, plan['source_packages']):
            snapshots.update(records)
    archive = tool.download('https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.65.1.tgz',
                            plan['rollup_wasm_archive_sha256'], plan['rollup_wasm_archive_bytes'])
    snapshots.update(stage(archive, project / 'node_modules/rollup', 'package'))
    esbuild_archive = tool.download('https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz', fork.ARCHIVE_SHA, 4 * 1024**2)
    esbuild = project / 'node_modules/esbuild'
    identity = fork.stage(esbuild_archive, ROOT, esbuild)
    snapshots.update({str(esbuild / name): digest for name, digest in identity['files_sha256'].items()})
    # The view intentionally contains no opaque platform addons, optional
    # watcher/LZMA modules, package-manager CLI or new user configuration.
    env = dict(PATH='/nonexistent', TMPDIR=str(scope / 'tmp'), LANG='C.UTF-8', TZ='UTC',
               ESBUILD_BINARY_PATH=str(binary), ESBUILD_WORKER_THREADS='0')
    node_base = [str(executable), '--permission', '--allow-fs-read=' + str(scope),
                 '--no-addons', '--disable-sigusr1', '--max-old-space-size=512']
    typecheck = tool.run(node_base + [str(project / 'node_modules/typescript/bin/tsc'), '--noEmit',
                                     '--project', str(project / 'tsconfig.json')], project, env, 45)
    if typecheck.strip():
        raise ValueError('unexpected TypeScript output')
    print(json.dumps(dict(frontend_phase='typecheck', passed=True,
                          application_commit=plan['application_commit'])), flush=True)
    build = tool.run(node_base + ['--allow-fs-write=' + str(project), '--allow-child-process',
                                  '--wasm-max-mem-pages=1024', str(project / 'node_modules/vite/bin/vite.js'),
                                  'build', '--config', str(project / 'vite.config.ts')], project, env, 45)
    if not (project / 'dist/index.html').is_file() or '@vite/client' in (project / 'dist/index.html').read_text():
        raise ValueError('production frontend output missing or contains dev client')
    scripts = list((project / 'dist/assets').glob('*.js'))
    if not scripts or not any(b'stellaruidesktopvpnapiprod.azurewebsites.net' in path.read_bytes() for path in scripts):
        raise ValueError('expected production API identity absent from built application')
    if list((project / 'dist').rglob('*.map')):
        raise ValueError('unexpected published source maps')
    for path, expected in snapshots.items():
        tool.verified(Path(path), expected)
    for path, expected in runtime_sources.items():
        tool.verified(scope / 'npm' / path, expected)
    return dict(application_commit=plan['application_commit'], typecheck=True, production_vite_build=True,
                vite='7.3.8', rollup='@rollup/wasm-node@4.65.1', esbuild='reviewed source fork 0.28.1-stellar.1',
                immutable_input_files=len(snapshots), tool_sources_unchanged=len(runtime_sources),
                production_api_identity_present=True, source_maps=False, build_log=build,
                app_executed=False, network_allowed=False, credentials_configured=False,
                npm_cli_executed=False, lifecycle_hooks_executed=False, official_lock_graph_adopted=False,
                explicit_empty_postcss_fixture=True,
                explicit_owned_workspace_root=True,
                native_binary_gate_waived=False, release_approved=False)
