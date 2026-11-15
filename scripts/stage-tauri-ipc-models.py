"""Bind additive IPC taint sources to the exact application source inventory."""
import hashlib
import json
from pathlib import Path
import re
import shutil


ATTRIBUTE = re.compile(r'#\[\s*tauri\s*::\s*command\b')
COMMAND = re.compile(r'#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+([a-z_][a-z_0-9]*)\(([^()]*)\)')
SOURCES = ('src-tauri/src/commands.rs', 'src-tauri/src/updates/mod.rs')
MODEL_NAME = 'stellar/tauri-ipc-models'
MODEL_VERSION = '0.1.0'
PROBE = '''import rust
import codeql.rust.dataflow.DataFlow
import codeql.rust.dataflow.FlowSource as Sources

from Function f, DataFlow::ParameterNode node, int position
where node.asParameter() = f.getParamList().getParam(position) and
  Sources::sourceNode(node, "remote") and
  f.getCanonicalPath().matches("stellar_vpn_desktop::commands::%")
select f.getCanonicalPath(), position
'''


def inventory(source, profile):
    expected = {row['path']: row['sha256'] for row in profile['files']}
    rows, commands, identities = [], [], {}
    command_files, scanned, total = set(), 0, 0
    for relative, digest in expected.items():
        if not relative.endswith('.rs'):
            continue
        path = Path(source) / relative
        if (path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024
                or not path.resolve().is_relative_to(Path(source).resolve())):
            raise ValueError('bounded regular Rust source required')
        raw = path.read_bytes()
        total += len(raw)
        scanned += 1
        if total > 32 * 1024**2 or scanned > 512 or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Rust source differs from reviewed application inputs')
        if ATTRIBUTE.search(raw.decode('utf-8')):
            command_files.add(relative)
    if command_files != set(SOURCES):
        raise ValueError('unaccounted IPC source file')
    for relative in SOURCES:
        path = Path(source) / relative
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
            raise ValueError('bounded regular IPC source required')
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected.get(relative):
            raise ValueError('IPC source differs from reviewed application inputs')
        identities[relative] = digest
        text = raw.decode('utf-8')
        matches = list(COMMAND.finditer(text))
        if len(matches) != len(ATTRIBUTE.findall(text)) or not matches:
            raise ValueError('unaccounted IPC command syntax')
        module = 'commands' if relative == SOURCES[0] else 'updates'
        for match in matches:
            canonical = 'stellar_vpn_desktop::' + module + '::' + match[1]
            if canonical in commands:
                raise ValueError('duplicate IPC command')
            commands.append(canonical)
            parameters = match[2].split(',') if match[2].strip() else []
            for position, parameter in enumerate(parameters):
                parsed = re.fullmatch(r'\s*([a-z_][a-z_0-9]*)\s*:\s*([A-Za-z_0-9:<>]+)\s*', parameter)
                if not parsed:
                    raise ValueError('unsupported IPC parameter syntax')
                name, kind = parsed.groups()
                if kind in ('AppHandle', 'tauri::AppHandle'):
                    if name != 'app':
                        raise ValueError('unexpected privileged IPC handle')
                    continue
                rows.append([canonical, f'Parameter[{position}]', 'remote', 'manual'])
    if not rows or len(rows) > 128 or len(commands) > 128:
        raise ValueError('IPC model inventory bounds')
    return dict(commands=sorted(commands), data=sorted(rows), source_sha256=identities, scanned_rust_files=scanned)


def validate_bindings(decoded, rows):
    tuples = decoded.get('#select', {}).get('tuples')
    if not isinstance(tuples, list) or len(tuples) > 128:
        raise ValueError('bounded IPC model binding result required')
    observed = set()
    for row in tuples:
        if (not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], str)
                or type(row[1]) is not int or row[1] < 0 or tuple(row) in observed):
            raise ValueError('invalid or duplicate IPC binding')
        observed.add(tuple(row))
    expected = {(row[0], int(row[1][10:-1])) for row in rows}
    if observed != expected:
        raise ValueError('IPC model did not bind every expected parameter')
    return sorted(observed)


def stage(source, destination, profile):
    bound = inventory(source, profile)
    destination = Path(destination)
    model = destination / 'stellar-tauri-ipc-models'
    probe = destination / 'stellar-tauri-ipc-probe'
    if any(path.exists() or path.is_symlink() for path in (model, probe)):
        raise ValueError('fresh application model destinations required')
    model.mkdir()
    probe.mkdir()
    (model / 'qlpack.yml').write_text(
        'name: ' + MODEL_NAME + '\nversion: ' + MODEL_VERSION + '\n'
        'extensionTargets:\n  codeql/rust-all: 0.2.25\ndataExtensions:\n  - ipc.model.json\n')
    (model / 'ipc.model.json').write_text(json.dumps(dict(extensions=[dict(
        addsTo=dict(pack='codeql/rust-all', extensible='sourceModel'), data=bound['data'])]), indent=2) + '\n')
    (probe / 'qlpack.yml').write_text(
        'name: stellar/tauri-ipc-probe\nversion: 0.1.0\ndependencies:\n  codeql/rust-all: 0.2.25\n')
    # Reuse only the already reviewed, source-only dependency closure. No pack
    # installation, registry lookup, compiled query, neutral model or barrier.
    shutil.copyfile(destination / 'rust-queries/codeql-pack.lock.yml', probe / 'codeql-pack.lock.yml')
    (probe / 'bindings.ql').write_text(PROBE)
    return dict(**bound, model_pack=MODEL_NAME + '@' + MODEL_VERSION,
                query=str(probe / 'bindings.ql'), source_only=True,
                neutral_or_barrier_models=0, release_approved=False)
