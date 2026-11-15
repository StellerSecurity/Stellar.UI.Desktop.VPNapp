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



BODY_EXPECTED = {
    ('crates/stellar-core/src/application.rs', 'restore_remembered_identity'),
    ('crates/stellar-core/src/application.rs', 'renew_account_session'),
    ('src-tauri/src/commands.rs', 'restore_account_session'),
    ('src-tauri/src/commands.rs', 'renew_account_session'),
    ('src-tauri/src/commands.rs', 'logout'),
    ('src-tauri/src/infrastructure/session.rs', 'save_with'),
    ('src-tauri/src/infrastructure/session.rs', 'load_with'),
    ('src-tauri/src/infrastructure/session_windows.rs', 'load_for'),
    ('src-tauri/src/infrastructure/session_windows.rs', 'save_for'),
}


def validate_bodies(result):
    rows = result.get('#select', {}).get('tuples') if isinstance(result, dict) else None
    if not isinstance(rows, list) or len(rows) > 4096:
        raise ValueError('invalid application body query result')
    observed = set()
    for row in rows:
        if not isinstance(row, list) or len(row) != 2 or not all(isinstance(x, str) for x in row):
            raise ValueError('invalid application body row')
        path, name = row[0].replace('\\', '/'), row[1]
        matches = [pair for pair in BODY_EXPECTED if name == pair[1] and
                   (path == pair[0] or path.endswith('/' + pair[0]))]
        if len(matches) == 1:
            if matches[0] in observed:
                raise ValueError('duplicate application function body')
            observed.add(matches[0])
    if observed != BODY_EXPECTED:
        raise ValueError('missing actual application function bodies: ' + repr(sorted(BODY_EXPECTED - observed)))
    return sorted(observed)



def source_snapshot(source):
    snapshot = {}
    total = 0
    for path in sorted(source.rglob('*')):
        if path.is_symlink():
            raise ValueError('analysis source symlink')
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > 8 * 1024**2 or total + size > 32 * 1024**2 or len(snapshot) >= 512:
            raise ValueError('analysis source snapshot bounds')
        total += size
        snapshot[path.relative_to(source).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return snapshot


def stage_native_approval(source):
    # Match the passed Windows build's exact approval-file layout. Copy the
    # existing reviewed record unchanged; do not manufacture a new approval or
    # remove the app build script's guard to make semantic extraction succeed.
    original = source / 'native/windows/compile-approval.json'
    if original.is_symlink():
        raise ValueError('native approval source symlink')
    raw = original.read_bytes()
    checksum = hashlib.sha256(raw).hexdigest()
    if checksum != '88200df590a36a5329ef38921085679905bdd827f5a50cf76304efbc2e28956d':
        raise ValueError('existing reviewed native approval changed')
    destination = source / '.security-review'
    if destination.exists() or destination.is_symlink():
        raise ValueError('fresh analysis approval directory required')
    destination.mkdir()
    path = destination / 'windows-native-compile-approval.json'
    with path.open('xb') as stream:
        stream.write(raw)
    return dict(path=path.relative_to(source).as_posix(), sha256=checksum, copied_without_changes=True)


def canonical_analysis_roots(work, source, stage):
    # On Windows resolve() expands existing 8.3 aliases (RUNNER~1) to the same
    # long paths used by CodeQL's Java pack resolver. Mixed aliases make result
    # interpretation see a query outside its own pack after successful evaluation.
    work, source, stage = (Path(path).resolve(strict=True) for path in (work, source, stage))
    if (not all(path.is_dir() for path in (work, source, stage)) or
            work not in source.parents or source.parent != stage):
        raise ValueError('unexpected canonical analysis output location')
    return source, stage


def prepare_stitched_sysroot(root, retained_manifest):
    """Select RA's built-in ten-crate graph, preserving every Rust source byte.

    The source-only projection intentionally excludes unreviewed vendor inputs.
    Its Cargo graph therefore cannot resolve offline. Keeping that incomplete
    graph silently defeats builtin macro semantics; RA's supported stitched
    source graph resolves core/std/alloc without inventing dependency metadata.
    This is analysis layout only, never an SDK or application modification.
    """
    root, retained_manifest = Path(root), Path(retained_manifest)
    manifest = root / 'Cargo.toml'
    if (root.is_symlink() or manifest.is_symlink() or not manifest.is_file()
            or retained_manifest.exists() or retained_manifest.is_symlink()
            or retained_manifest.parent.resolve(strict=True) != root.parent.resolve(strict=True)
            or manifest.stat().st_size > 65536):
        raise ValueError('unexpected sysroot analysis manifest layout')
    raw = manifest.read_bytes()
    expected = 'b346ae33bd9648949894510a2bcc1d1f8b78c7301c3110e4a98b68bacd3b4584'
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('reviewed sysroot manifest changed')
    manifest.rename(retained_manifest)
    if retained_manifest.read_bytes() != raw:
        raise ValueError('retained sysroot manifest changed')
    return dict(mode='rust-analyzer-stitched', retained_manifest_sha256=expected,
                rust_source_modified=False, vendor_dependencies_added=False,
                full_standard_library_dependency_graph=False)


def native_resource_path_budget(stage):
    # The exact reviewed compiler copies clui.dll below the root crate's OUT_DIR.
    # Its language-resource loader still fails at MAX_PATH even when Python and
    # Rust accept the longer path. Reserve worst-case PID/nonce lengths up front.
    projected = str(stage) + '/database/working/target/debug/build/stellar-vpn-desktop-' + 'f' * 16
    projected += '/out/stellar-native-' + '9' * 10 + '-' + '9' * 20 + '/tools/1033/clui.dll'
    if len(projected) >= 240:
        raise ValueError('analysis path exceeds reviewed compiler resource-loader budget')
    return dict(projected_native_resource_path_chars=len(projected), limit_chars=240)


def security_suite(stage, env, guard, runtime, database):
    """Run the unmodified official suite from verified source-only local packs."""
    helper_path = Path(__file__).with_name('stage-reviewed-rust-queries.py')
    spec = importlib.util.spec_from_file_location('firstparty_query_source', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    profile = json.loads(Path(__file__).with_name('rust-query-source-inputs.json').read_bytes())
    destination = stage / 'reviewed-query-source'
    copied = helper.stage_source(Path(runtime['codeql_root']) / 'qlpacks/codeql', destination, profile)
    before = copied.pop('snapshot')
    codeql = str(Path(runtime['codeql_root']) / 'codeql.exe')
    caches = stage / 'query-caches'
    common = ['--additional-packs=' + str(destination), '--common-caches=' + str(caches)]
    resolved = guard.run([codeql, 'resolve', 'qlpacks', '--format=json'] + common, stage, env, 60, capture=True)
    output = resolved.pop('output')
    try:
        start = output.index('{')
        mapping, end = json.JSONDecoder().raw_decode(output[start:])
        if output[start + end:].strip() or not isinstance(mapping, dict):
            raise ValueError('unexpected query resolution trailer')
        resolution_diagnostics = output[:start].splitlines()
        if any('error' in line.casefold() or 'failed' in line.casefold() for line in resolution_diagnostics):
            raise ValueError('query resolution reported an error')
    except (ValueError, TypeError):
        print(json.dumps(dict(query_pack_resolution_output=output)))
        raise ValueError('expected exact source query-pack resolution JSON')
    helper.validate_resolution(mapping, destination, profile['manifests'])
    suite = destination / 'rust-queries/codeql-suites/rust-security-and-quality.qls'
    query_resolution = guard.run([codeql, 'resolve', 'queries', '--format=json', str(suite)] + common,
                                stage, env, 60, capture=True)
    query_output = query_resolution.pop('output')
    start = query_output.index('[')
    query_paths, end = json.JSONDecoder().raw_decode(query_output[start:])
    if query_output[start + end:].strip():
        raise ValueError('unexpected suite resolution trailer')
    resolution_diagnostics.extend(query_output[:start].splitlines())
    selected = helper.validate_queries(query_paths, destination, profile)
    if not any('/security/' in path for path in selected):
        raise ValueError('official suite selected no security queries')
    sarif_path = stage / 'rust-security-and-quality.sarif'
    command = [codeql, 'database', 'analyze', str(database), str(suite), '--no-download',
               '--format=sarifv2.1.0', '--output=' + str(sarif_path), '--threads=2', '--ram=3072',
               '--no-default-compilation-cache', '--compilation-cache=' + str(stage / 'query-compilation'),
               '--no-sarif-add-file-contents', '--no-sarif-add-snippets', '--no-sarif-add-query-help'] + common
    print(json.dumps(dict(security_suite_started=True, source_projection=copied,
                          resolved_exact_packs=len(profile['manifests']), suite=suite.name)), flush=True)
    analyzed = guard.run(command, stage, env, 1500, capture=True)
    logs = analyzed.pop('output')
    diagnostics = [line for line in logs.splitlines() if any(word in line.casefold() for word in ('warning', 'error', 'failed'))]
    if helper.snapshot(destination) != before:
        raise ValueError('security query source was modified during analysis')
    if not sarif_path.is_file() or sarif_path.stat().st_size > 32 * 1024**2:
        raise ValueError('security suite SARIF output bounds')
    sarif = json.loads(sarif_path.read_bytes())
    runs = sarif.get('runs')
    if sarif.get('version') != '2.1.0' or not isinstance(runs, list) or not runs or len(runs) > 4:
        raise ValueError('unexpected security suite SARIF format')
    findings, notifications, rules, analysis_properties = [], [], [], []
    for run in runs:
        # Retain coverage/summary metrics, not just alerts. An empty alert list
        # cannot demonstrate complete extraction or data-flow coverage.
        analysis_properties.append(run.get('properties', {}))
        rules.extend(rule['id'] for rule in run.get('tool', {}).get('driver', {}).get('rules', []))
        findings.extend(run.get('results', []))
        for invocation in run.get('invocations', []):
            if invocation.get('executionSuccessful') is False:
                raise ValueError('security suite reported unsuccessful execution')
            notifications.extend(invocation.get('toolExecutionNotifications', []))
            notifications.extend(invocation.get('toolConfigurationNotifications', []))
    if len(findings) > 10000 or len(notifications) > 10000:
        raise ValueError('security suite result count bounds')
    return dict(suite='rust-security-and-quality', source_projection=copied, commands=[resolved, query_resolution, analyzed], selected_query_files=selected,
                query_rule_ids=sorted(set(rules)), findings=findings, notifications=notifications,
                analysis_properties=analysis_properties,
                resolution_diagnostics=resolution_diagnostics, diagnostics=diagnostics, source_files_unchanged=len(before),
                sarif_sha256=hashlib.sha256(sarif_path.read_bytes()).hexdigest(),
                security_query_suite_executed=True, release_approved=False)

def body_probe(source, stage, env, guard, runtime):
    path_budget = native_resource_path_budget(stage)
    codeql = Path(runtime['codeql_root']) / 'codeql.exe'
    schema = Path(runtime['codeql_root']) / 'rust/rust.dbscheme'
    if hashlib.sha256(schema.read_bytes()).hexdigest() != 'f412b260f76bdaad67d06973b8edc65e057ba723bd206d9fd12e653fa0aaf900':
        raise ValueError('actual application query schema changed')
    env.update(CODEQL_JAVA_HOME=runtime['java_root'], CODEQL_DIST=runtime['codeql_root'], CODEQL_PLATFORM='win64')
    env['PATH'] = str(Path(runtime['rust_root']) / 'bin') + ';' + str(Path(runtime['java_root']) / 'bin') + ';C:/Windows/System32'
    database = stage / 'database'
    helper_path = Path(__file__).with_name('stage-reviewed-rust-sysroot.py')
    profile = json.loads(Path(__file__).with_name('rust-sysroot-source-inputs.json').read_bytes())
    spec = importlib.util.spec_from_file_location('firstparty_sysroot_source', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    sysroot = helper.stage_source(stage / 'reviewed-sysroot-source', profile)
    sysroot['analysis_layout'] = prepare_stitched_sysroot(
        sysroot['source_root'], stage / 'retained-sysroot-Cargo.toml')
    env['RUST_SRC_PATH'] = sysroot['source_root']
    # Official extractor Config::sysroot supports both explicit paths. Its
    # get_extra_env enables Rustup auto-install before applying cargo_extra_env;
    # override that default so analysis can only use the reviewed offline SDK.
    env['CODEQL_EXTRACTOR_RUST_OPTION_SYSROOT'] = runtime['rust_root']
    env['CODEQL_EXTRACTOR_RUST_OPTION_SYSROOT_SRC'] = sysroot['source_root']
    env['CODEQL_EXTRACTOR_RUST_OPTION_CARGO_EXTRA_ENV'] = 'RUSTUP_AUTO_INSTALL=0,CARGO_NET_OFFLINE=true'
    env['RUSTUP_AUTO_INSTALL'] = '0'
    env['RUST_LOG'] = 'warn,ra_ap_project_model=debug,ra_ap_load_cargo=debug'
    env['PATH'] += ';C:/Windows/System32/WindowsPowerShell/v1.0'
    state_file = stage / 'reviewed-toolchain-environment.json'
    toolchain = Path(__file__).with_name('windows-codeql-toolchain.ps1')
    guard.run(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-NonInteractive',
               '-File', str(toolchain), '-SourceRoot', str(source), '-OutputDirectory', str(stage / 'reviewed-toolchain'),
               '-StateFile', str(state_file)], stage, env, 120)
    if not state_file.is_file() or state_file.stat().st_size > 65536:
        raise ValueError('reviewed compiler preparation state bounds')
    native = json.loads(state_file.read_bytes())
    allowed = {'PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'RC', 'RC_x86_64_pc_windows_msvc',
               'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'CC_x86_64_pc_windows_msvc',
               'CXX_x86_64_pc_windows_msvc', 'AR_x86_64_pc_windows_msvc'}
    if set(native['environment']) != allowed or native['nativeProgramsExecuted'] is not False:
        raise ValueError('unexpected compiler preparation scope')
    for name, value in native.pop('environment').items():
        if not isinstance(value, str):
            raise ValueError('invalid compiler environment data')
        env[name] = value
    print(json.dumps(dict(reviewed_compiler_preparation=native)))
    native_approval = stage_native_approval(source)
    before = source_snapshot(source)
    commands = [guard.run([str(codeql), 'database', 'create', str(database), '--language=rust', '--build-mode=none', '--no-calculate-baseline',
                          '--source-root=' + str(source), '--extractor-option=rust.extract_dependencies_as_source=false',
                          '--extractor-option=rust.cargo_features=default', '--threads=2', '--ram=3072'], source, env, 900, capture=True)]
    creation_output = commands[0].pop('output')
    diagnostics = [line for line in creation_output.splitlines() if 'error' in line.casefold() or 'warning' in line.casefold() or 'failed' in line.casefold()]
    environment_diagnostics = [line for line in creation_output.splitlines()
                               if any(word in line.casefold() for word in ('cargo', 'build script', 'out_dir', 'proc-macro', 'sysroot'))]
    print(json.dumps(dict(semantic_environment_diagnostics=environment_diagnostics,
                          creation_log_sha256=commands[0]['log_sha256'],
                          release_approved=False)), flush=True)
    if any('[error]' in line.casefold() or 'extraction failed' in line.casefold() for line in diagnostics):
        print(json.dumps(dict(extraction_diagnostics=diagnostics, release_approved=False)))
        raise ValueError('actual application extraction reported fatal errors')
    # Preserve every warning for review. This diagnostic may query a completed
    # database, but cannot turn warning-bearing coverage into release clearance.
    queries = stage / 'queries'
    queries.mkdir()
    query = queries / 'application-bodies.ql'
    query.write_bytes(('from @function f, @name n, @block_expr body, @location_default loc, @file file, string label, string path\n'
                       'where functions(f) and function_names(f, n) and name_texts(n, label) and\n'
                       'function_function_bodies(f, body) and function_has_implementation(f) and\n'
                       'locatable_locations(f, loc) and locations_default(loc, file, _, _, _, _) and files(file, path) and\n'
                       'label = ' + json.dumps(sorted({name for _, name in BODY_EXPECTED})) + '\nselect path, label\n').encode())
    output = stage / 'application-bodies.bqrs'
    commands.append(guard.run([str(codeql), 'query', 'run', '--database=' + str(database), '--dbscheme=' + str(schema),
                               '--output=' + str(output), '--threads=2', '--ram=1024', str(query)], queries, env, 120))
    decoded = stage / 'application-bodies.json'
    commands.append(guard.run([str(codeql), 'bqrs', 'decode', '--format=json', '--output=' + str(decoded), str(output)], stage, env, 30))
    if not decoded.is_file() or decoded.stat().st_size > 1024**2:
        raise ValueError('application query output bounds')
    if source_snapshot(source) != before:
        raise ValueError('analysis modified actual source inputs')
    bodies = validate_bodies(json.loads(decoded.read_bytes()))
    # Preserve the coverage evidence even if later suite resolution/compilation
    # fails. A completed body query is never a release/security-suite pass.
    print(json.dumps(dict(actual_authentication_body_coverage=bodies,
                          extraction_diagnostics=diagnostics,
                          analysis_source_files_unchanged=len(before),
                          security_query_suite_executed=False, release_approved=False)), flush=True)
    if any('macro expansion failed' in line.casefold() for line in diagnostics):
        raise ValueError('actual application macro extraction remains incomplete')
    security = security_suite(stage, env, guard, runtime, database)
    if source_snapshot(source) != before:
        raise ValueError('security suite modified actual source inputs')
    return dict(commands=commands, sysroot_analysis_inputs=sysroot, reviewed_compiler_preparation=native, native_build_approval_layout=native_approval, native_path_budget=path_budget, extraction_diagnostics=diagnostics, analysis_source_files_unchanged=len(before), function_bodies=bodies, security_analysis=security,
                windows_scope_only=True, coverage_diagnostics_status='requires-review' if diagnostics else 'no-diagnostics',
                security_query_suite_executed=True, release_approved=False)


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
    with tempfile.TemporaryDirectory(prefix='s-') as folder:
        work = Path(folder).resolve(strict=True)
        for name in ('home', 'temp', 'rustup'):
            (work / name).mkdir()
        rust = Path(runtime['rust_root']) / 'bin'
        env = dict(SystemRoot='C:\\Windows', WINDIR='C:\\Windows', COMSPEC='C:\\Windows\\System32\\cmd.exe',
                   ProgramFiles='C:\\Program Files', USERPROFILE='C:\\Users\\runneradmin',
                   HOME=str(work/'home'), TEMP=str(work/'temp'), TMP=str(work/'temp'), RUNNER_TEMP=str(work),
                   PATH=str(rust) + ';C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
        env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
        env['SystemDrive'] = 'C:'
        env['OS'] = 'Windows_NT'
        env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)'
        prepare = root / 'windows-codeql-source.ps1'
        guard.run(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive',
                   '-File', str(prepare), '-SourceCommit', plan['app_reference']], root, env, 600)
        # The preparation writes only this fixed, task-owned metadata file.
        state_path = work / 'source-preparation.json'
        if not state_path.is_file() or state_path.stat().st_size > 65536:
            raise ValueError('source preparation result missing/oversized')
        state = json.loads(state_path.read_bytes())
        source, stage = canonical_analysis_roots(work, state['sourceRoot'], state['stageRoot'])
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
        extraction = body_probe(source, stage, env, guard, runtime) if plan.get('application_body_probe') is True else None
        if hashlib.sha256((source/'Cargo.lock').read_bytes()).hexdigest() != lock_before:
            raise ValueError('lock changed in analysis layout')
        for name, expected in rust_sources.items():
            if hashlib.sha256((source/name).read_bytes()).hexdigest() != expected:
                raise ValueError('actual Rust source changed')
        print(json.dumps(dict(source_files_verified=len(inputs), rust_sources_unchanged=len(rust_sources),
                              registry_archives_verified=state['lockedArchivesVerified'],
                              offline_metadata_packages=len(metadata['packages']), moved_vendor_manifests=moved,
                              source_root_contains_cargo_cache=False, lock_unchanged=True,
                              codeql_application_extraction=extraction, app_executed=False,
                              signing=False, released=False)))


if __name__ == '__main__':
    main()
