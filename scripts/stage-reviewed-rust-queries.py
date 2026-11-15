"""Stage exact reviewed QL source; exclude installed compiled queries/caches."""
import hashlib
from pathlib import Path, PurePosixPath
import re


def dependencies(text):
    result = {}
    active = False
    for line in text.splitlines():
        if line == 'dependencies: {}':
            return result
        if line == 'dependencies:':
            active = True
            continue
        if not active:
            continue
        if line and not line.startswith(' '):
            break
        match = re.fullmatch(r'  codeql/([a-z0-9-]+): ([0-9]+\.[0-9]+\.[0-9]+)', line)
        if not match or match[1] in result:
            raise ValueError('unsupported or duplicate QL dependency')
        result[match[1]] = match[2]
    return result


def snapshot(root):
    result = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('query source symlink')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            if path.stat().st_size > 8 * 1024**2 or len(result) >= 2048:
                raise ValueError('query source snapshot bounds')
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def validate_resolution(mapping, destination, manifests):
    """The legacy resolver lists shadowed SDK paths too; first is precedence."""
    if not isinstance(mapping, dict):
        raise ValueError('query pack resolution mapping required')
    for row in manifests:
        paths = mapping.get('codeql/' + row['package'])
        if (not isinstance(paths, list) or not paths or not isinstance(paths[0], str) or
                Path(paths[0]).resolve() != (Path(destination) / row['package']).resolve()):
            raise ValueError('query pack precedence is outside verified sources')
    return len(manifests)


def validate_queries(paths, destination, profile):
    if not isinstance(paths, list) or not 1 <= len(paths) <= 256:
        raise ValueError('bounded nonempty official suite query list required')
    root = Path(destination).resolve()
    verified = {row['package'] + '/' + row['path'] for row in profile['files']}
    seen = set()
    for value in paths:
        if not isinstance(value, str) or not Path(value).resolve().is_relative_to(root):
            raise ValueError('query selected outside verified sources')
        relative = Path(value).resolve().relative_to(root).as_posix()
        if (relative not in verified or relative in seen or not relative.endswith('.ql') or
                not relative.startswith('rust-queries/queries/')):
            raise ValueError('unreviewed or duplicate selected query')
        seen.add(relative)
    return sorted(seen)


def stage_source(base, destination, profile, expected_files=1211, expected_packs=15):
    base, destination = Path(base), Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('fresh query source destination required')
    manifests = {}
    for row in profile['manifests']:
        package, version, text = row['package'], row['version'], row['manifest']
        if (not re.fullmatch('[a-z0-9-]+', package) or
                not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or package in manifests or
                len(text.encode()) > 16384 or '\0' in text or
                '\nname: codeql/' + package + '\n' not in text or
                '\nversion: ' + version + '\n' not in text):
            raise ValueError('exact QL manifest metadata required')
        path = base / package / version / 'qlpack.yml'
        if path.is_symlink() or path.read_bytes() != text.encode():
            raise ValueError('installed QL manifest changed')
        manifests[package] = (version, text, dependencies(text))
    if len(manifests) != expected_packs:
        raise ValueError('incomplete QL pack inventory')
    for _, _, deps in manifests.values():
        for name, version in deps.items():
            if name not in manifests or manifests[name][0] != version:
                raise ValueError('unbound QL dependency')
    verified, seen, total = [], set(), 0
    for row in profile['files']:
        package, version, relative = row['package'], row['version'], row['path']
        path = PurePosixPath(relative)
        if (package not in manifests or version != manifests[package][0] or
                str(path) != relative or path.is_absolute() or '..' in path.parts or
                any(c in relative for c in ('\\', ':', '\0')) or
                any(part.startswith('.') for part in path.parts) or
                path.suffix.lower() in ('.md', '.qlx') or
                relative in ('qlpack.yml', 'codeql-pack.lock.yml')):
            raise ValueError('non-source or uncontained QL input')
        name = package + '/' + relative
        if name.casefold() in seen:
            raise ValueError('duplicate QL source path')
        seen.add(name.casefold())
        source = base / package / version / relative
        if (source.is_symlink() or not source.is_file() or
                not source.resolve().is_relative_to((base / package / version).resolve()) or
                source.stat().st_size != row['bytes'] or row['bytes'] > 8 * 1024**2):
            raise ValueError('installed QL source changed')
        data = source.read_bytes()
        total += len(data)
        if (total > 32 * 1024**2 or len(seen) > expected_files or
                hashlib.sha256(data).hexdigest() != row['sha256'] or
                hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != row['git_blob_sha1']):
            raise ValueError('official QL source identity mismatch')
        verified.append((name, data))
    if len(verified) != expected_files:
        raise ValueError('incomplete QL source inventory')
    destination.mkdir()
    for name, data in verified:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for package, (_, text, deps) in manifests.items():
        root = destination / package
        root.mkdir(exist_ok=True)
        (root / 'qlpack.yml').write_bytes(text.encode())
        closure, pending = {}, list(deps)
        while pending:
            name = pending.pop()
            if name == package or name in closure:
                continue
            closure[name] = manifests[name][0]
            pending.extend(manifests[name][2])
        lock = '---\nlockVersion: 1.0.0\n'
        lock += 'dependencies:\n' if closure else 'dependencies: {}\n'
        lock += ''.join('  codeql/' + name + ':\n    version: ' + closure[name] + '\n' for name in sorted(closure))
        lock += 'compiled: false\n'
        (root / 'codeql-pack.lock.yml').write_bytes(lock.encode())
    return dict(source_files=len(verified), packs=len(manifests), bytes=total,
                precompiled_queries_copied=0, downloads=0, snapshot=snapshot(destination))
