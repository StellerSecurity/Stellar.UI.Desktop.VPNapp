"""Offline production-crate regressions from the already locked GLib sources."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent


def fetch(url, expected, maximum):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=30) as response:
        if response.geturl() != url:
            raise ValueError('unexpected reviewed source redirect')
        raw = response.read(maximum + 1)
    if len(raw) > maximum or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('reviewed source identity changed')
    return raw


def stage_archive(raw, row, destination):
    if len(raw) != row['archive_bytes'] or hashlib.sha256(raw).hexdigest() != row['checksum']:
        raise ValueError('source archive differs from exact lock identity')
    prefix = row['name'] + '-' + row['version']
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            if member.isdir():
                continue
            parts = PurePosixPath(member.name).parts
            if (not member.isfile() or not parts or parts[0] != prefix or '..' in parts
                    or member.name.startswith('/') or '\\' in member.name
                    or member.size > 16 * 1024**2 or len(files) >= 20000):
                raise ValueError('uncontained source archive member')
            relative = '/'.join(parts[1:])
            if not relative or relative in files:
                raise ValueError('ambiguous source member')
            data = archive.extractfile(member).read(member.size + 1)
            total += len(data)
            if len(data) != member.size or total > 160 * 1024**2:
                raise ValueError('source expansion bound')
            files[relative] = hashlib.sha256(data).hexdigest()
            path = destination / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as output:
                output.write(data)
    if '.cargo-checksum.json' in files:
        raise ValueError('registry source cannot supply vendor checksum policy')
    checksum = json.dumps(dict(files=files, package=row['checksum']), sort_keys=True).encode()
    (destination / '.cargo-checksum.json').write_bytes(checksum)
    return {**files, '.cargo-checksum.json': hashlib.sha256(checksum).hexdigest()}


def validate_lock(raw, plan):
    expected = {(row['name'], row['version']): row['checksum'] for row in plan['registry_packages']}
    observed = set()
    for row in tomllib.loads(raw.decode())['package']:
        pair = (row['name'], row['version'])
        if row.get('source') is None:
            if pair not in {('glib', '0.18.5'), ('stellar-glib-regression', '0.0.0')}:
                raise ValueError('unexpected local test package')
        elif (row.get('source') != 'registry+https://github.com/rust-lang/crates.io-index'
              or pair not in expected or row.get('checksum') != expected[pair]):
            raise ValueError('test resolution escaped the reviewed dependency graph')
        observed.add(pair)
    if ('glib', '0.18.5') not in observed:
        raise ValueError('production GLib crate was not selected')
    return sorted(observed)


def main():
    if os.uname().sysname != 'Linux' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('isolated Linux CI required')
    plan = json.loads((ROOT / 'glib-crate-integration-plan.json').read_text())
    native = json.loads((ROOT / 'glib-iterator-native-plan.json').read_text())
    runtime = json.loads((ROOT / 'runtime-review.json').read_text())
    spec = importlib.util.spec_from_file_location('reviewed_native_probe', ROOT / 'linux-glib-iterator-probe.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    rust = Path('/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu')
    compiler_pins = {}
    for row in runtime['files']:
        name = row['path']
        if row['root'] == str(rust) and (name in ('bin/cargo', 'bin/rustc') or name.startswith(('lib/librustc_driver-', 'lib/libLLVM.so.', 'lib/rustlib/x86_64-unknown-linux-gnu/lib/'))):
            guard.verified(rust / name, row['sha256'])
            compiler_pins[str(rust / name)] = row['sha256']
    if len(compiler_pins) < 40 or str(rust / 'bin/cargo') not in compiler_pins:
        raise ValueError('incomplete compiler approval view')
    pins = dict(native['native_sha256'])
    gobject = Path('/usr/lib/x86_64-linux-gnu/libgobject-2.0.so.0.8000.0')
    pins[str(gobject)] = '2bf396b14b469ca2eed46a785b3bc0bd1fd979261c6bf505bc4debdcd0a6870a'
    for name, expected in pins.items():
        guard.verified(Path(name), expected)
    if len(plan['registry_packages']) != 52 or len(plan['local_source_files']) != 113 or not re.fullmatch('[a-f0-9]{40}', plan['local_source_snapshot_commit']):
        raise ValueError('exact source inventory required')
    with tempfile.TemporaryDirectory(prefix='stellar-glib-crate-') as directory:
        work = Path(directory)
        project, registry, local = work / 'project', work / 'registry', work / 'glib'
        for path in (project / 'src', project / 'tests', work / 'cargo-home', work / 'tmp', work / 'lib'):
            path.mkdir(parents=True)
        (work / 'lib/libglib-2.0.so').symlink_to('/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0.8000.0')
        (work / 'lib/libgobject-2.0.so').symlink_to(gobject)
        snapshots = {}
        def stage_package(row):
            name = row['name'] + '-' + row['version']
            url = 'https://static.crates.io/crates/' + row['name'] + '/' + name + '.crate'
            raw = fetch(url, row['checksum'], row['archive_bytes'])
            destination = registry / name
            return destination, stage_archive(raw, row, destination)
        with ThreadPoolExecutor(max_workers=4) as executor:
            for destination, files in executor.map(stage_package, plan['registry_packages']):
                snapshots.update({str(destination / name): digest for name, digest in files.items()})
        def stage_local(row):
            relative = row['path'].removeprefix('vendor/glib-0.18.5/')
            if relative == row['path'] or '..' in PurePosixPath(relative).parts:
                raise ValueError('unexpected local source path')
            url = 'https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/' + plan['local_source_snapshot_commit'] + '/' + row['path']
            data = fetch(url, row['sha256'], 2 * 1024**2)
            path = local / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return str(path), row['sha256']
        with ThreadPoolExecutor(max_workers=4) as executor:
            snapshots.update(dict(executor.map(stage_local, plan['local_source_files'])))
        (project / 'Cargo.toml').write_text('[package]\nname="stellar-glib-regression"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nglib={path="../glib",default-features=false}\n[workspace]\n')
        (project / 'src/lib.rs').write_text('// First-party production-crate regression harness.\n')
        (project / 'tests/production.rs').write_bytes((ROOT / 'glib-crate-production-tests.rs').read_bytes())
        (work / 'cargo-home/config.toml').write_text('[source.crates-io]\nreplace-with="reviewed-sources"\n[source.reviewed-sources]\ndirectory='+json.dumps(str(registry))+'\n[net]\noffline=true\n')
        linker = rust / 'lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld'
        wrapper = work / 'linker-guard.py'
        wrapper.write_text('''#!/usr/bin/python3
import hashlib,os,sys
from pathlib import Path
linker=''' + repr(str(linker)) + '''
expected=''' + repr(pins[str(linker)]) + '''
if hashlib.sha256(Path(linker).read_bytes()).hexdigest()!=expected: raise SystemExit('linker hash changed')
args=sys.argv[1:]
if len(args)>4096 or sum(map(len,args))>1024*1024: raise SystemExit('linker argument budget')
if '-flavor' not in args: args=['-flavor','gnu']+args
if '-shared' not in args and '--shared' not in args:
    args+=['/usr/lib/x86_64-linux-gnu/Scrt1.o','--dynamic-linker=/lib64/ld-linux-x86-64.so.2','-pie']
args+=['/usr/lib/x86_64-linux-gnu/crti.o','/usr/lib/x86_64-linux-gnu/crtn.o']
os.execve(linker,[linker]+args,dict(os.environ))
''')
        wrapper.chmod(0o700)
        for path in [project / 'Cargo.toml', project / 'src/lib.rs', project / 'tests/production.rs',
                     work / 'cargo-home/config.toml', wrapper]:
            snapshots[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        source_inventory = {str(path) for root in (registry, local) for path in root.rglob('*') if path.is_file()}
        flags = ['-C', 'linker=' + str(wrapper), '-C', 'linker-flavor=ld.lld', '-L', 'native=' + str(work / 'lib'),
                 '-L', 'native=/usr/lib/x86_64-linux-gnu', '-L', 'native=/usr/lib/gcc/x86_64-linux-gnu/13']
        env = dict(PATH='/nonexistent', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC',
                   CARGO_HOME=str(work / 'cargo-home'), CARGO_NET_OFFLINE='true',
                   CARGO_TARGET_DIR=str(work / 'target'), RUSTC=str(rust / 'bin/rustc'),
                   RUSTC_WRAPPER='', RUSTC_WORKSPACE_WRAPPER='', CARGO_ENCODED_RUSTFLAGS='\x1f'.join(flags),
                   SYSTEM_DEPS_GLIB_2_0_NO_PKG_CONFIG='1', SYSTEM_DEPS_GLIB_2_0_LIB='glib-2.0',
                   SYSTEM_DEPS_GLIB_2_0_SEARCH_NATIVE=str(work / 'lib'),
                   SYSTEM_DEPS_GOBJECT_2_0_NO_PKG_CONFIG='1', SYSTEM_DEPS_GOBJECT_2_0_LIB='gobject-2.0',
                   SYSTEM_DEPS_GOBJECT_2_0_SEARCH_NATIVE=str(work / 'lib'), SYSTEM_DEPS_BUILD_INTERNAL='never',
                   G_DEBUG='fatal-warnings', RUST_BACKTRACE='0')
        cargo = str(rust / 'bin/cargo')
        guard.run([cargo, 'generate-lockfile', '--offline'], project, env, 60)
        lock = (project / 'Cargo.lock').read_bytes()
        selected = validate_lock(lock, plan)
        reports = []
        for profile in ('dev', 'release'):
            result = guard.run([cargo, 'test', '--offline', '--locked', '--profile', profile, '--test', 'production',
                                '--message-format=json', '--', '--test-threads=1'], project, env, 360)
            if '5 passed; 0 failed' not in result['output']:
                raise ValueError('five complete production-crate tests required')
            if any('gio-sys@' in line for line in result['output'].splitlines() if '"reason":"compiler-artifact"' in line):
                raise ValueError('excluded GIO compiled unexpectedly')
            reports.append(dict(profile=profile, output_sha256=result['output_sha256'], tests=5,
                                summary=result['output'][result['output'].rfind('running 5 tests'):]))
        if (project / 'Cargo.lock').read_bytes() != lock:
            raise ValueError('test modified locked dependency graph')
        for name, expected in {**snapshots, **compiler_pins, **pins}.items():
            guard.verified(Path(name), expected)
        after_inventory = {str(path) for root in (registry, local) for path in root.rglob('*') if path.is_file()}
        if after_inventory != source_inventory or any(path.is_symlink() for root in (registry, local) for path in root.rglob('*')):
            raise ValueError('build changed immutable source inventory')
        if os.readlink(work / 'lib/libglib-2.0.so') != '/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0.8000.0' or os.readlink(work / 'lib/libgobject-2.0.so') != str(gobject):
            raise ValueError('explicit native library selection changed')
        print(json.dumps(dict(full_production_glib_crate_compiled=True, original_local_source_files_unchanged=113,
            registry_archives_verified=52, source_files_unchanged=len(snapshots), selected_packages=selected, reports=reports,
            gtk_loaded=False, gio_loaded=False, package_installation=False, registry_network_during_build=False,
            retained_advisories=plan['known_maintenance_advisories'],
            fixed_upstream_iterator_advisories=plan['known_upstream_glib_advisories'],
            unresolved_native_advisory='CVE-2026-86469 remains a Linux release restriction; this test excludes GIO.',
            app_lock_changed=False, full_desktop_test=False, release_approved=False)))


if __name__ == '__main__':
    main()
