"""Approval-gated first-party manifest-layout and database-body assertion probe.

Four synthetic libraries; one unused first-party dev fixture outside source root.
No application/dependency source, registry downloads, hooks or release approval.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import zipfile

RUNTIME_PIN = 'c8965ee984ca699e87fead31b46c68330c645759f85bd63711c77ebe64eaf0db'
SCHEMA_SHA = 'f412b260f76bdaad67d06973b8edc65e057ba723bd206d9fd12e653fa0aaf900'
EXPECTED = {
    ('app/src/lib.rs', 'probe_app'),
    ('core/src/lib.rs', 'probe_core'),
    ('vendor/one/src/lib.rs', 'probe_vendor_one'),
    ('vendor/two/src/lib.rs', 'probe_vendor_two'),
}
QUERY = '''from @function f, @name n, @block_expr body, @location_default loc,
     @file file, string label, string path
where
  functions(f) and function_names(f, n) and name_texts(n, label) and
  function_function_bodies(f, body) and function_has_implementation(f) and
  locatable_locations(f, loc) and locations_default(loc, file, _, _, _, _) and
  files(file, path) and
  label = ["probe_app", "probe_core", "probe_vendor_one", "probe_vendor_two", "probe_unused_dev"]
select path, label
'''


def fixture(work):
    files = {
        'source/Cargo.toml': '[workspace]\nmembers=["app","core"]\nresolver="2"\n',
        'source/app/Cargo.toml': '[package]\nname="stellar-layout-app"\nversion="0.0.0"\nedition="2021"\nbuild=false\n[dependencies]\ncore_fixture={package="stellar-layout-core",path="../core"}\none={package="stellar-layout-one",path="../../metadata/one"}\ntwo={package="stellar-layout-two",path="../../metadata/two"}\n',
        'source/core/Cargo.toml': '[package]\nname="stellar-layout-core"\nversion="0.0.0"\nedition="2021"\nbuild=false\n',
        'source/app/src/lib.rs': 'pub fn probe_app() -> bool { core_fixture::probe_core() && one::probe_vendor_one() && two::probe_vendor_two() }\n',
        'source/core/src/lib.rs': 'pub fn probe_core() -> bool { true }\n',
        'source/vendor/one/src/lib.rs': 'pub fn probe_vendor_one() -> bool { true }\n',
        'source/vendor/two/src/lib.rs': 'pub fn probe_vendor_two() -> bool { true }\n',
        'metadata/one/Cargo.toml': '[package]\nname="stellar-layout-one"\nversion="0.0.0"\nedition="2021"\nbuild=false\n[lib]\npath="../../source/vendor/one/src/lib.rs"\n[dev-dependencies]\nunused={package="stellar-layout-unused",path="../unused-dev"}\n',
        'metadata/two/Cargo.toml': '[package]\nname="stellar-layout-two"\nversion="0.0.0"\nedition="2021"\nbuild=false\n[lib]\npath="../../source/vendor/two/src/lib.rs"\n',
        'metadata/unused-dev/Cargo.toml': '[package]\nname="stellar-layout-unused"\nversion="0.0.0"\nedition="2021"\nbuild=false\n',
        'metadata/unused-dev/src/lib.rs': 'pub fn probe_unused_dev() -> bool { false }\n',
        'source/Cargo.lock': 'version=4\n\n[[package]]\nname="stellar-layout-app"\nversion="0.0.0"\ndependencies=["stellar-layout-core","stellar-layout-one","stellar-layout-two"]\n\n[[package]]\nname="stellar-layout-core"\nversion="0.0.0"\n\n[[package]]\nname="stellar-layout-one"\nversion="0.0.0"\n\n[[package]]\nname="stellar-layout-two"\nversion="0.0.0"\n',
    }
    for name, content in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode())
    return {name: hashlib.sha256(content.encode()).hexdigest() for name, content in files.items()}


def validate_rows(result):
    rows = result.get('#select', {}).get('tuples') if isinstance(result, dict) else None
    if not isinstance(rows, list) or len(rows) != 4:
        raise ValueError('not exactly four function-body database rows')
    observed = set()
    for row in rows:
        if not isinstance(row, list) or len(row) != 2 or not all(isinstance(x, str) for x in row):
            raise ValueError('unexpected query result shape')
        path, label = row
        matches = [pair for pair in EXPECTED if label == pair[1] and
                   (path == pair[0] or path.endswith('/' + pair[0]))]
        if len(matches) != 1 or matches[0] in observed:
            raise ValueError('wrong or duplicate source/function body')
        observed.add(matches[0])
    if observed != EXPECTED:
        raise ValueError('missing function-body coverage')
    return sorted(observed)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--approved-plan-sha256')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    raw = args.plan.read_bytes()
    if len(raw) > 65536:
        raise ValueError('probe plan byte budget')
    plan = json.loads(raw)
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != plan['harness_sha256']:
        raise ValueError('first-party layout harness drift')
    if hashlib.sha256(QUERY.encode()).hexdigest() != plan['query_sha256']:
        raise ValueError('first-party query drift')
    runtime_raw = (root / 'runtime-review.json').read_bytes()
    if hashlib.sha256(runtime_raw).hexdigest() != RUNTIME_PIN:
        raise ValueError('reviewed runtime plan drift')
    runtime = json.loads(runtime_raw)
    helper = root / 'codeql-rust-probe.py'
    if hashlib.sha256(helper.read_bytes()).hexdigest() != runtime['harness_sha256']:
        raise ValueError('first-party runtime guard drift')
    spec = importlib.util.spec_from_file_location('firstparty_probe_guard', helper)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    guard.verify_files(runtime['files'])
    schema = Path(guard.CODEQL) / 'rust/rust.dbscheme'
    if schema.is_symlink() or hashlib.sha256(schema.read_bytes()).hexdigest() != SCHEMA_SHA:
        raise ValueError('Rust database schema drift')
    if args.approved_plan_sha256 is None:
        print(json.dumps(dict(preflight_passed=True, native_execution=False,
                              explicit_layout_query_approval_required=True)))
        return
    if args.approved_plan_sha256 != hashlib.sha256(raw).hexdigest():
        raise ValueError('exact layout/query execution approval required')
    with tempfile.TemporaryDirectory(prefix='stellar-codeql-layout-', dir='/tmp') as folder:
        work = Path(folder)
        before = fixture(work)
        source = work / 'source'
        for name in ('home', 'cargo', 'rustup', 'tmp', 'target', 'queries'):
            (work / name).mkdir()
        rust, codeql, java = guard.RUST, guard.CODEQL + '/codeql', guard.JAVA
        env = dict(PATH=rust + '/bin:/usr/bin:/bin', HOME=str(work / 'home'),
                   LANG='C.UTF-8', TMPDIR=str(work / 'tmp'), CODEQL_DIST=guard.CODEQL,
                   CODEQL_PLATFORM='linux64', CODEQL_JAVA_HOME=java,
                   CARGO_HOME=str(work / 'cargo'), CARGO_NET_OFFLINE='true',
                   CARGO_TARGET_DIR=str(work / 'target'), RUSTUP_HOME=str(work / 'rustup'),
                   RUSTUP_TOOLCHAIN=rust, RUSTC=rust + '/bin/rustc', CARGO=rust + '/bin/cargo',
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9',
                   ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        commands = []
        commands.append(guard.run([rust + '/bin/cargo', 'metadata', '--format-version', '1',
                                   '--no-deps', '--locked', '--offline'], source, env,
                                  work / 'metadata.log', 30))
        database = work / 'database'
        commands.append(guard.run([codeql, 'database', 'create', str(database), '--language=rust',
                                   '--build-mode=none', '--source-root=' + str(source),
                                   '--extractor-option=rust.extract_dependencies_as_source=true',
                                   '--threads=2', '--ram=3072'], source, env,
                                  work / 'extract.log', 300))
        diagnostic = (work / 'extract.log').read_text(errors='replace')
        if any(term in diagnostic.lower() for term in
               ('unable to load manifest', 'failed to load manifest', 'no manifest found')):
            raise ValueError('synthetic manifest discovery failed')
        archive_path = database / 'src.zip'
        if not archive_path.is_file() or archive_path.stat().st_size > 128 * 1024**2:
            raise ValueError('source archive missing/oversized')
        source_hashes = {name[len('source/'):]: digest for name, digest in before.items()
                         if name.startswith('source/') and name.endswith('.rs')}
        observed = {}
        with zipfile.ZipFile(archive_path) as archive:
            if len(archive.infolist()) > 10000:
                raise ValueError('source archive member budget')
            for item in archive.infolist():
                for name, expected in source_hashes.items():
                    if item.filename == name or item.filename.endswith('/source/' + name):
                        if name in observed or item.file_size > 8192:
                            raise ValueError('duplicate/oversized fixture source')
                        digest = hashlib.sha256(archive.read(item)).hexdigest()
                        if digest != expected:
                            raise ValueError('source archive bytes differ')
                        observed[name] = digest
        if observed != source_hashes:
            raise ValueError('not all four Rust sources archived')
        query = work / 'queries/coverage.ql'
        query.write_text(QUERY)
        output = work / 'coverage.bqrs'
        commands.append(guard.run([codeql, 'query', 'run', '--database=' + str(database),
                                   '--dbscheme=' + str(schema), '--output=' + str(output),
                                   '--threads=2', '--ram=1024', str(query)], work / 'queries', env,
                                  work / 'query.log', 120))
        decoded = work / 'coverage.json'
        commands.append(guard.run([codeql, 'bqrs', 'decode', '--format=json',
                                   '--output=' + str(decoded), str(output)], work, env,
                                  work / 'decode.log', 30))
        if not decoded.is_file() or decoded.stat().st_size > 65536:
            raise ValueError('query result byte budget')
        rows = validate_rows(json.loads(decoded.read_text()))
        if any(hashlib.sha256((work / name).read_bytes()).hexdigest() != digest for name, digest in before.items()):
            raise ValueError('fixture source/manifest/lock mutated')
        current = {str(path.relative_to(work)) for base in ('source', 'metadata')
                   for path in (work / base).rglob('*') if path.is_file()}
        if current != set(before):
            raise ValueError('unexpected fixture source/lock output')
        print(json.dumps(dict(commands=commands, source_files_archived=len(observed),
                              database_function_bodies=rows, first_party_only=True,
                              unused_dev_fixture_body_absent=True, source_lock_unchanged=True,
                              application_analyzed=False, package_hooks_executed=False,
                              dependency_downloaded=False, released=False,
                              scope='Layout and function-body extraction proof only; not app-wide semantic or security approval.')))


if __name__ == '__main__':
    main()
