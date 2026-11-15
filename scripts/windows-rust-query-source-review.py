"""Inspect exact installed QL source files as data, never execute query packs."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

root = Path(__file__).resolve().parent
profile = json.loads((root / 'rust-query-source-inputs.json').read_bytes())
plan = json.loads((root / 'rust-query-source-review-plan.json').read_bytes())
for name, expected in plan['first_party_inputs'].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise ValueError('static source review helper/profile drift')
base = Path('C:/hostedtoolcache/windows/CodeQL/2.27.4/x64/codeql/qlpacks/codeql')
sys.path.insert(0, str(root))
import content_guard
inspector = content_guard.Inspector()
seen = set()
for row in profile['files']:
    package, version, relative = row['package'], row['version'], row['path']
    if not re.fullmatch('[a-z0-9-]+', package) or not re.fullmatch('[0-9.]+', version) or str(PurePosixPath(relative)) != relative or relative.startswith(('/', '.codeql/')) or '..' in PurePosixPath(relative).parts or any(c in relative for c in ('\\', ':', '\0')):
        raise ValueError('exact QL source path containment')
    name = package + '/' + version + '/' + relative
    if name.casefold() in seen or relative.endswith(('.qlx', '.md', '.MD')):
        raise ValueError('duplicate or non-source query input')
    seen.add(name.casefold())
    path = base / package / version / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to((base/package/version).resolve()) or path.stat().st_size != row['bytes'] or path.stat().st_size > 8 * 1024**2:
        raise ValueError('installed QL source input changed')
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != row['sha256'] or hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() != row['git_blob_sha1']:
        raise ValueError('official QL source identity mismatch')
    inspector.content(name, data)
if len(seen) != 1211:
    raise ValueError('incomplete exact QL source inventory')
report = inspector.report(profile['source_commit'], 'official-rust-query-source-text-only')
print(json.dumps(dict(verified_source_files=len(seen), inspection=report,
                      source_executed=False, precompiled_queries_executed=False,
                      full_package_clearance=False, signing=False, released=False), separators=(',', ':')))
