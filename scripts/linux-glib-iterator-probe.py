"""Compile the exact production string iterator against a pinned real GLib.

No Cargo/package hooks, GTK, GIO, app launch or release clearance. The first-party
harness supplies only ownership/FFI glue and keeps the iterator bytes unchanged.
"""
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
SOURCE_SHA = 'a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc'
SNIPPET_SHA = '7f76947c06a340a2f7a6e6f92e63a4399d2d536228ddc750ab806f673f52853a'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def iterator_source(raw):
    if digest(raw) != SOURCE_SHA:
        raise ValueError('production iterator source changed')
    start = raw.index(b'/// Iterator over items in a variant of type `as`.')
    end = raw.index(b'\n#[cfg(test)]', start)
    snippet = raw[start:end]
    if digest(snippet) != SNIPPET_SHA:
        raise ValueError('production iterator slice changed')
    return snippet


def verified(path, expected):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024**2:
        raise ValueError('regular bounded reviewed file required')
    raw = path.read_bytes()
    if digest(raw) != expected:
        raise ValueError('reviewed native input changed: ' + path.name)
    return raw


def run(command, work, env, seconds):
    def limits():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True, preexec_fn=limits)
        started = time.monotonic()
        while process.poll() is None:
            if time.monotonic() - started > seconds or os.fstat(output.fileno()).st_size > 4 * 1024**2:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise ValueError('native regression resource bound')
            time.sleep(0.1)
        output.seek(0)
        raw = output.read(4 * 1024**2 + 1)
        if process.returncode != 0 or len(raw) > 4 * 1024**2:
            raise ValueError('native regression failed: ' + raw[-12000:].decode(errors='replace'))
        return dict(exit_code=0, output_sha256=digest(raw), output=raw.decode(errors='replace'))


def main():
    if os.uname().sysname != 'Linux' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('isolated Linux CI required')
    plan = json.loads((ROOT / 'glib-iterator-native-plan.json').read_text())
    if digest(Path(__file__).read_bytes()) != plan['script_sha256']:
        raise ValueError('first-party probe drift')
    runtime = json.loads((ROOT / 'runtime-review.json').read_text())
    rust_root = Path('/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu')
    pins = {}
    for row in runtime['files']:
        if row['root'] != str(rust_root):
            continue
        name = row['path']
        if name == 'bin/rustc' or name.startswith('lib/librustc_driver-') or name.startswith('lib/libLLVM.so.') or name.startswith('lib/rustlib/x86_64-unknown-linux-gnu/lib/'):
            path = rust_root / name
            verified(path, row['sha256'])
            pins[str(path)] = row['sha256']
    if len(pins) < 40 or str(rust_root / 'bin/rustc') not in pins:
        raise ValueError('incomplete reviewed compiler view')
    for filename, expected in plan['native_sha256'].items():
        verified(Path(filename), expected)
    source = verified(ROOT / 'variant_iter.rs', SOURCE_SHA)
    harness = verified(ROOT / 'glib-iterator-harness.rs', plan['harness_sha256'])
    linker = rust_root / 'lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld'
    glib = Path('/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0.8000.0')
    with tempfile.TemporaryDirectory(prefix='stellar-glib-iterator-') as directory:
        work = Path(directory)
        (work / 'tmp').mkdir()
        (work / 'lib').mkdir()
        (work / 'lib/libglib_probe.so').symlink_to(glib)
        (work / 'variant-str-iter.rs').write_bytes(iterator_source(source))
        (work / 'harness.rs').write_bytes(harness)
        env = dict(PATH='/nonexistent', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC',
                   G_DEBUG='fatal-warnings', RUST_BACKTRACE='0')
        reports = []
        for label, optimization in [('debug', '0'), ('release', '3')]:
            executable = work / ('iterator-' + label)
            command = [str(rust_root / 'bin/rustc'), '--edition=2021', '--test', str(work / 'harness.rs'),
                       '--sysroot', str(rust_root), '-C', 'linker=' + str(linker), '-C', 'linker-flavor=ld.lld',
                       '-C', 'opt-level=' + optimization, '-C', 'debuginfo=0',
                       '-L', 'native=' + str(work / 'lib'), '-L', 'native=/usr/lib/x86_64-linux-gnu',
                       '-L', 'native=/usr/lib/gcc/x86_64-linux-gnu/13',
                       '-C', 'link-arg=/usr/lib/x86_64-linux-gnu/Scrt1.o',
                       '-C', 'link-arg=/usr/lib/x86_64-linux-gnu/crti.o',
                       '-C', 'link-arg=/usr/lib/x86_64-linux-gnu/crtn.o',
                       '-C', 'link-arg=--dynamic-linker=/lib64/ld-linux-x86-64.so.2',
                       '-C', 'link-arg=-pie', '-o', str(executable)]
            compiled = run(command, work, env, 240)
            identity = digest(executable.read_bytes())
            tested = run([str(executable), '--test-threads=1'], work, env, 30)
            if '5 passed; 0 failed' not in tested['output']:
                raise ValueError('all five native regressions must execute')
            reports.append(dict(profile=label, binary_sha256=identity, compile=compiled, test=tested))
        for filename, expected in {**pins, **plan['native_sha256']}.items():
            verified(Path(filename), expected)
        print(json.dumps(dict(source_sha256=SOURCE_SHA, exact_iterator_sha256=SNIPPET_SHA,
            compiler_files_verified=len(pins), native_pins_verified=len(plan['native_sha256']), reports=reports,
            actual_iterator_implementation_unchanged=True, ffi_library='Official Ubuntu GLib 2.80.0-6ubuntu3.10',
            gio_loaded=False, gio_known_advisory='CVE-2026-86469 remains unresolved; excluded GIO is not release-cleared.',
            full_glib_crate_integration_test=False, full_desktop_test=False, installed=False,
            app_executed=False, release_approved=False)))


if __name__ == '__main__':
    main()
