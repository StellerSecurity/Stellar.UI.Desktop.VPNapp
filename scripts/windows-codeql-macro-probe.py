"""Isolate builtin-macro extraction with reviewed tools and synthetic Rust only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    root = Path(__file__).resolve().parent
    plan = json.loads((root / 'windows-codeql-probe-plan.json').read_bytes())
    for row in plan['files']:
        path = Path(row['root']) / row['path']
        if (path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024**2
                or 'bytes' in row and path.stat().st_size != row['bytes']
                or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']):
            raise ValueError('reviewed runtime identity changed')
    guard = module(root / 'windows-codeql-probe.py', 'firstparty_guard')
    fixture = module(root / 'codeql-layout-probe.py', 'firstparty_fixture')
    sysroot_helper = module(root / 'stage-reviewed-rust-sysroot.py', 'firstparty_sysroot')
    with tempfile.TemporaryDirectory(prefix='stellar-codeql-builtin-') as folder:
        work = Path(folder).resolve(strict=True)
        before = fixture.fixture(work)
        target = work / 'source/core/src/lib.rs'
        target.write_bytes(target.read_bytes() + b'\npub fn probe_format(value: &str) -> String { format!("saved:{}", value) }\npub fn probe_match(value: Option<u8>) -> bool { matches!(value, Some(1)) }\npub fn probe_cfg() -> bool { cfg!(target_os = "windows") }\n')
        before['source/core/src/lib.rs'] = hashlib.sha256(target.read_bytes()).hexdigest()
        for name in ('home', 'cargo', 'rustup', 'temp', 'target'):
            (work / name).mkdir()
        profile = json.loads((root / 'rust-sysroot-source-inputs.json').read_bytes())
        sysroot = sysroot_helper.stage_source(work / 'reviewed-sysroot', profile)
        rust = Path(plan['rust_root']) / 'bin'
        env = dict(PATH=str(rust) + ';' + str(Path(plan['java_root']) / 'bin') + ';C:/Windows/System32',
                   SystemRoot='C:/Windows', WINDIR='C:/Windows', COMSPEC='C:/Windows/System32/cmd.exe',
                   HOME=str(work / 'home'), USERPROFILE=str(work / 'home'),
                   TEMP=str(work / 'temp'), TMP=str(work / 'temp'),
                   CODEQL_JAVA_HOME=plan['java_root'], CODEQL_DIST=plan['codeql_root'], CODEQL_PLATFORM='win64',
                   CARGO_HOME=str(work / 'cargo'), CARGO_NET_OFFLINE='true', CARGO_TARGET_DIR=str(work / 'target'),
                   RUSTUP_HOME=str(work / 'rustup'), RUSTUP_TOOLCHAIN=plan['rust_root'], RUSTUP_AUTO_INSTALL='0',
                   RUSTC=str(rust / 'rustc.exe'), CARGO=str(rust / 'cargo.exe'),
                   RUST_SRC_PATH=sysroot['source_root'], CODEQL_EXTRACTOR_RUST_OPTION_SYSROOT=plan['rust_root'],
                   CODEQL_EXTRACTOR_RUST_OPTION_SYSROOT_SRC=sysroot['source_root'],
                   CODEQL_EXTRACTOR_RUST_OPTION_CARGO_EXTRA_ENV='RUSTUP_AUTO_INSTALL=0,CARGO_NET_OFFLINE=true',
                   CODEQL_EXTRACTOR_RUST_OPTION_LOGGING_VERBOSITY='info',
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        command = [str(Path(plan['codeql_root']) / 'codeql.exe'), 'database', 'create', str(work / 'database'),
                   '--language=rust', '--build-mode=none', '--no-calculate-baseline',
                   '--source-root=' + str(work / 'source'),
                   '--extractor-option=rust.extract_dependencies_as_source=false', '--threads=2', '--ram=3072']
        result = guard.run(command, work / 'source', env, 480, capture=True)
        output = result.pop('output')
        interesting = [line for line in output.splitlines() if any(word in line.casefold() for word in
                       ('warning', 'error', 'failed', 'sysroot', 'cargo metadata', 'stdlib', 'proc_macro', 'toolchain'))]
        if any(hashlib.sha256((work / name).read_bytes()).hexdigest() != digest for name, digest in before.items()):
            raise ValueError('synthetic source input changed')
        macro_failures = [line for line in interesting if 'macro expansion failed' in line]
        print(json.dumps(dict(synthetic_builtin_macros=['format', 'matches', 'cfg'],
                              command=result, diagnostics=interesting, macro_expansion_failures=len(macro_failures),
                              source_files_unchanged=len(before), app_analyzed=False, app_executed=False,
                              release_approved=False)), flush=True)
        if macro_failures:
            raise ValueError('synthetic builtin macro expansion remains incomplete')


if __name__ == '__main__':
    main()
