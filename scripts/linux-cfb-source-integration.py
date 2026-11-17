"""Test source-only CFB packaging with release-enforced buffer boundaries."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def selected_lock(raw, plan):
    expected = {(row['name'], row['version']): row['checksum'] for row in plan['registry_packages']}
    seen = set()
    for row in tomllib.loads(raw.decode())['package']:
        key = row['name'], row['version']
        if key in seen:
            raise ValueError('duplicate test lock identity')
        seen.add(key)
        if row.get('source') is None:
            if key != ('cfb', '0.14.0') or 'checksum' in row:
                raise ValueError('unexpected local package')
        elif (row.get('source') != 'registry+https://github.com/rust-lang/crates.io-index'
              or expected.get(key) != row.get('checksum')):
            raise ValueError('CFB test lock escaped the original app graph')
    if ('cfb', '0.14.0') not in seen:
        raise ValueError('production package absent from test lock')
    return sorted(seen)

def main():
    if os.uname().sysname != 'Linux' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('isolated Linux CI required')
    commit = os.environ.get('SOURCE_COMMIT', '')
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('immutable source commit required')
    plan = json.loads((ROOT / 'cfb-source-integration-plan.json').read_text())
    if len(plan['source_files']) != 25 or len(plan['registry_packages']) != 31:
        raise ValueError('closed CFB source inventory required')
    stage = load('reviewed_registry_staging', 'linux-glib-crate-integration.py')
    guard = load('reviewed_native_boundary', 'linux-glib-iterator-probe.py')
    runtime = json.loads((ROOT / 'runtime-review.json').read_text())
    native = json.loads((ROOT / 'glib-iterator-native-plan.json').read_text())
    rust = Path('/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu')
    compiler_pins = {}
    for row in runtime['files']:
        name = row['path']
        if row['root'] == str(rust) and (name in ('bin/cargo', 'bin/rustc') or name.startswith(
                ('lib/librustc_driver-', 'lib/libLLVM.so.', 'lib/rustlib/x86_64-unknown-linux-gnu/lib/'))):
            guard.verified(rust / name, row['sha256'])
            compiler_pins[str(rust / name)] = row['sha256']
    if len(compiler_pins) < 40 or str(rust / 'bin/cargo') not in compiler_pins:
        raise ValueError('incomplete reviewed compiler view')
    pins = native['native_sha256']
    for name, checksum in pins.items():
        guard.verified(Path(name), checksum)
    with tempfile.TemporaryDirectory(prefix='stellar-cfb-source-') as folder:
        work = Path(folder)
        source, registry = work / 'cfb', work / 'registry'
        for target in (source, registry, work / 'cargo-home', work / 'tmp'):
            target.mkdir()
        snapshots = {}
        for row in plan['source_files']:
            prefix = 'native/cfb-source-only/'
            if not row['path'].startswith(prefix):
                raise ValueError('unexpected prototype source path')
            relative = row['path'][len(prefix):]
            if '..' in PurePosixPath(relative).parts or relative.endswith('.md'):
                raise ValueError('invalid prototype member')
            raw = stage.fetch('https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/'
                              + commit + '/' + row['path'], row['sha256'], 1024**2)
            if len(raw) != row['bytes']:
                raise ValueError('prototype member length changed')
            name = 'Cargo.toml' if relative == 'package-template.toml' else relative
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            snapshots[str(target)] = row['sha256']
        def registry_source(row):
            name = row['name'] + '-' + row['version']
            raw = stage.fetch('https://static.crates.io/crates/' + row['name'] + '/' + name + '.crate',
                              row['checksum'], row['archive_bytes'])
            target = registry / name
            return target, stage.stage_archive(raw, row, target)
        with ThreadPoolExecutor(max_workers=4) as executor:
            for target, files in executor.map(registry_source, plan['registry_packages']):
                snapshots.update({str(target / name): checksum for name, checksum in files.items()})
        config = work / 'cargo-home/config.toml'
        config.write_text('[source.crates-io]\nreplace-with="reviewed-sources"\n[source.reviewed-sources]\ndirectory='
                          + json.dumps(str(registry)) + '\n[net]\noffline=true\n')
        linker = rust / 'lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld'
        link_wrapper = work / 'linker-guard.py'
        link_wrapper.write_text('''#!/usr/bin/python3
import hashlib,os,sys
from pathlib import Path
linker=''' + repr(str(linker)) + '''
expected=''' + repr(pins[str(linker)]) + '''
if hashlib.sha256(Path(linker).read_bytes()).hexdigest()!=expected: raise SystemExit('linker changed')
args=sys.argv[1:]
if len(args)>4096 or sum(map(len,args))>1024*1024: raise SystemExit('linker argument bound')
if '-flavor' not in args: args=['-flavor','gnu']+args
if '-shared' not in args and '--shared' not in args:
    args+=['/usr/lib/x86_64-linux-gnu/Scrt1.o','--dynamic-linker=/lib64/ld-linux-x86-64.so.2','-pie']
args+=['/usr/lib/x86_64-linux-gnu/crti.o','/usr/lib/x86_64-linux-gnu/crtn.o']
os.execve(linker,[linker]+args,dict(os.environ))
''')
        link_wrapper.chmod(0o700)
        compiler_wrapper = work / 'compiler-guard.py'
        compiler_wrapper.write_text('''#!/usr/bin/python3
import hashlib,os,sys
from pathlib import Path
compiler=''' + repr(str(rust / 'bin/rustc')) + '''
expected=''' + repr(compiler_pins[str(rust / 'bin/rustc')]) + '''
allowed=''' + repr(set(plan['allowed_native_crate_names'])) + '''
if sys.argv[1]!=compiler or hashlib.sha256(Path(compiler).read_bytes()).hexdigest()!=expected: raise SystemExit('compiler changed')
args=sys.argv[2:]
if len(args)>4096 or sum(map(len,args))>1024*1024: raise SystemExit('compiler argument bound')
if '--crate-name' in args:
    name=args[args.index('--crate-name')+1]
    probe=name=='___' and any(x.startswith('--print') for x in args) and not any(x in args for x in ('--out-dir','--emit','--extern'))
    if name not in allowed and not probe: raise SystemExit('unapproved build script or macro crate')
elif not args or any(x not in ('-vV','--version','-V','--print=sysroot','--print=target-libdir') for x in args):
    raise SystemExit('unapproved compiler probe')
os.execve(compiler,[compiler]+args,dict(os.environ))
''')
        compiler_wrapper.chmod(0o700)
        for path in (config, link_wrapper, compiler_wrapper):
            snapshots[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        source_inventory = {str(path) for root in (source, registry) for path in root.rglob('*') if path.is_file()}
        flags = ['-C', 'linker=' + str(link_wrapper), '-C', 'linker-flavor=ld.lld',
                 '-L', 'native=/usr/lib/x86_64-linux-gnu', '-L', 'native=/usr/lib/gcc/x86_64-linux-gnu/13']
        env = dict(PATH='/nonexistent', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC',
                   CARGO_HOME=str(work / 'cargo-home'), CARGO_NET_OFFLINE='true', CARGO_INCREMENTAL='0',
                   CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_RELEASE_DEBUG='0', CARGO_TARGET_DIR=str(work / 'target'),
                   RUSTC=str(rust / 'bin/rustc'), RUSTC_WRAPPER=str(compiler_wrapper), RUSTC_WORKSPACE_WRAPPER='',
                   CARGO_ENCODED_RUSTFLAGS='\x1f'.join(flags), RUST_BACKTRACE='0')
        cargo = str(rust / 'bin/cargo')
        guard.run([cargo, 'generate-lockfile', '--offline'], source, env, 60)
        lock = (source / 'Cargo.lock').read_bytes()
        selected = selected_lock(lock, plan)
        reports = []
        for profile in ('dev', 'release'):
            result = guard.run([cargo, 'test', '--offline', '--locked', '--profile', profile,
                                '--lib', '--message-format=json', '--', '--test-threads=1'], source, env, 360)
            compiled = set()
            for line in result['output'].splitlines():
                if not line.startswith('{'):
                    continue
                event = json.loads(line)
                if event.get('reason') == 'build-script-executed':
                    raise ValueError('unexpected package hook executed')
                if event.get('reason') == 'compiler-artifact':
                    compiled.add(event['target']['name'])
            if not compiled <= set(plan['allowed_native_crate_names']) or 'cfb' not in compiled:
                raise ValueError('native compilation escaped source-only scope')
            if '103 passed; 0 failed; 1 ignored' not in result['output']:
                raise ValueError('all unchanged library regression tests required')
            reports.append(dict(profile=profile, tests_passed=103, upstream_maintenance_generator_ignored=1,
                                compiled_crates=sorted(compiled), output_sha256=result['output_sha256']))
        if (source / 'Cargo.lock').read_bytes() != lock:
            raise ValueError('test lock changed')
        for name, checksum in {**snapshots, **compiler_pins, **pins}.items():
            guard.verified(Path(name), checksum)
        observed = {str(path) for root in (source, registry) for path in root.rglob('*') if path.is_file()}
        if observed != source_inventory | {str(source / 'Cargo.lock')}:
            raise ValueError('source inventory changed during regression tests')
        print(json.dumps(dict(source_files_unchanged=len(snapshots), original_production_files=23, unchanged_production_files=22,
                              original_library_test_functions=99, added_bounds_regressions=5, reports=reports, selected_packages=selected,
                              registry_archives_verified=31, package_hooks_executed=False,
                              registry_network_during_build=False, office_documents_present=False,
                              original_fuzz_documents_cleared=False, app_graph_changed=False,
                              source_only_packaging_adopted=False, release_approved=False)))

if __name__ == '__main__':
    main()
