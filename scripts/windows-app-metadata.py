"""Prepare reviewed app sources and test the real offline analysis graph only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile


def relocate(source, metadata):
    changes = []
    for relative in ('vendor/glib-0.18.5', 'vendor/embed-resource-3.0.12'):
        original = source / relative / 'Cargo.toml'
        text = original.read_bytes().decode('utf-8')
        library = json.dumps((source / relative / 'src/lib.rs').as_posix())
        if relative.endswith('embed-resource-3.0.12'):
            if text.count('path = "src/lib.rs"') != 1:
                raise ValueError('unexpected embed-resource library target')
            text = text.replace('path = "src/lib.rs"', 'path = ' + library)
        else:
            if text.count('[lib]\nname = "glib"\n') != 1:
                raise ValueError('unexpected GLib library target')
            text = text.replace('[lib]\nname = "glib"\n', '[lib]\nname = "glib"\npath = ' + library + '\n')
            # Preserve explicit test/bench targets and their feature declarations.
            for kind, name, path in (('test', 'subclass_compiletest', 'tests/subclass_compiletest.rs'),
                                     ('bench', 'gstring', 'benches/gstring.rs')):
                needle = '[[' + kind + ']]\nname = "' + name + '"\n'
                if text.count(needle) != 1:
                    raise ValueError('unexpected GLib declared target')
                text = text.replace(needle, needle + 'path = ' + json.dumps((source / relative / path).as_posix()) + '\n')
            for path in sorted((source / relative / 'tests').glob('*.rs')):
                if path.stem != 'subclass_compiletest':
                    text += '\n[[test]]\nname = ' + json.dumps(path.stem) + '\npath = ' + json.dumps(path.as_posix()) + '\n'
        destination = metadata / Path(relative).name / 'Cargo.toml'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(text.encode('utf-8'))
        root_manifest = source / 'Cargo.toml'
        root = root_manifest.read_bytes().decode('utf-8')
        needle = 'path = "' + relative + '"'
        if root.count(needle) != 1:
            raise ValueError('unexpected root path override')
        root_manifest.write_bytes(root.replace(needle, 'path = ' + json.dumps(destination.parent.as_posix())).encode('utf-8'))
        original.unlink()
        changes.append(relative)
    return changes


def main():
    root = Path(__file__).resolve().parent
    plan = json.loads((root / 'windows-app-metadata-plan.json').read_bytes())
    for name, expected in plan['first_party_inputs'].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError('first-party preparation helper drift')
    runtime_raw = (root / 'windows-codeql-probe-plan.json').read_bytes()
    if hashlib.sha256(runtime_raw).hexdigest() != plan['runtime_plan_sha256']:
        raise ValueError('reviewed Windows runtime plan drift')
    runtime = json.loads(runtime_raw)
    for row in runtime['files']:
        path = Path(row['root']) / row['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024**2 or ('bytes' in row and path.stat().st_size != row['bytes']) or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('reviewed runtime file changed')
    helper = root / 'windows-codeql-probe.py'
    if hashlib.sha256(helper.read_bytes()).hexdigest() != runtime['script_sha256']:
        raise ValueError('reviewed process/resource guard drift')
    spec = importlib.util.spec_from_file_location('firstparty_windows_guard', helper)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    with tempfile.TemporaryDirectory(prefix='stellar-app-analysis-') as folder:
        work = Path(folder)
        for name in ('home', 'temp', 'rustup'):
            (work / name).mkdir()
        rust = Path(runtime['rust_root']) / 'bin'
        env = dict(SystemRoot='C:\\Windows', WINDIR='C:\\Windows', COMSPEC='C:\\Windows\\System32\\cmd.exe',
                   ProgramFiles='C:\\Program Files', USERPROFILE='C:\\Users\\runneradmin',
                   HOME=str(work/'home'), TEMP=str(work/'temp'), TMP=str(work/'temp'), RUNNER_TEMP=str(work),
                   PATH=str(rust) + ';C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
        env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)'
        prepare = root / 'windows-codeql-source.ps1'
        guard.run(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive',
                   '-File', str(prepare), '-SourceCommit', plan['app_reference']], root, env, 600)
        # The preparation writes only this fixed, task-owned metadata file.
        state_path = work / 'source-preparation.json'
        if not state_path.is_file() or state_path.stat().st_size > 65536:
            raise ValueError('source preparation result missing/oversized')
        state = json.loads(state_path.read_bytes())
        source, stage = Path(state['sourceRoot']), Path(state['stageRoot'])
        if work.resolve() not in source.resolve().parents or source.parent != stage:
            raise ValueError('unexpected preparation output location')
        inputs = json.loads((root / 'windows-app-source-inputs.json').read_bytes())['files']
        for row in inputs:
            if hashlib.sha256((source / row['path']).read_bytes()).hexdigest() != row['sha256']:
                raise ValueError('actual app source bytes changed during preparation')
        rust_sources = {row['path']: row['sha256'] for row in inputs if row['path'].endswith('.rs')}
        lock_before = hashlib.sha256((source / 'Cargo.lock').read_bytes()).hexdigest()
        moved = relocate(source, stage/'analysis-manifests')
        if set(state['environment']) != set(plan['exported_environment']):
            raise ValueError('missing or unexpected build environment field')
        if state['lockedArchivesVerified'] != len(plan['registry_packages']):
            raise ValueError('incomplete reviewed archive graph')
        for key, value in state['environment'].items():
            if key not in plan['exported_environment'] or not isinstance(value, str):
                raise ValueError('unexpected build environment field')
            env[key] = value
        env.update(RUSTC=str(rust/'rustc.exe'), CARGO=str(rust/'cargo.exe'), CARGO_NET_OFFLINE='true',
                   RUSTUP_HOME=str(work/'rustup'), RUSTUP_TOOLCHAIN=runtime['rust_root'],
                   HOME=str(work/'home'), USERPROFILE=str(work/'home'),
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        # Capture bounded Cargo JSON directly; no source build or package hook.
        result = guard.run([str(rust/'cargo.exe'), 'metadata', '--format-version', '1', '--locked', '--offline'],
                           source, env, 60, capture=True)
        # Cargo may emit non-JSON diagnostic lines before its single JSON object.
        payload = next((line for line in result['output'].splitlines() if line.startswith('{"packages":')), None)
        if payload is None:
            raise ValueError('actual offline Cargo graph result missing')
        metadata = json.loads(payload)
        registry = {(row['name'], row['version']) for row in plan['registry_packages']}
        local = {tuple(row) for row in plan['local_packages']}
        observed = set()
        for row in metadata['packages']:
            pair = (row['name'], row['version'])
            if pair in observed:
                raise ValueError('duplicate package identity')
            observed.add(pair)
            if row['source'] is None:
                if pair not in local:
                    raise ValueError('unexpected local package')
            elif row['source'] != 'registry+https://github.com/rust-lang/crates.io-index' or pair not in registry:
                raise ValueError('unexpected registry package')
        if observed != registry | local:
            raise ValueError('incomplete or expanded offline metadata graph')
        if hashlib.sha256((source/'Cargo.lock').read_bytes()).hexdigest() != lock_before:
            raise ValueError('lock changed in analysis layout')
        for name, expected in rust_sources.items():
            if hashlib.sha256((source/name).read_bytes()).hexdigest() != expected:
                raise ValueError('actual Rust source changed')
        print(json.dumps(dict(source_files_verified=len(inputs), rust_sources_unchanged=len(rust_sources),
                              registry_archives_verified=state['lockedArchivesVerified'],
                              offline_metadata_packages=len(metadata['packages']), moved_vendor_manifests=moved,
                              source_root_contains_cargo_cache=False, lock_unchanged=True,
                              codeql_application_extraction=False, app_executed=False,
                              signing=False, released=False)))


if __name__ == '__main__':
    main()
