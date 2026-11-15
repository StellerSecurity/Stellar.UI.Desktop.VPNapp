"""Verify the analysis-only layout preserves Rust bytes and Cargo targets."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('metadata_layout', ROOT / 'scripts/windows-app-metadata.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='stellar-layout-test-')
        self.addCleanup(self.temp.cleanup)
        self.stage = Path(self.temp.name)
        self.source = self.stage / 'source'
        self.source.mkdir()
        for name in ('Cargo.toml', 'Cargo.lock'):
            shutil.copyfile(ROOT / name, self.source / name)
        for name in ('glib-0.18.5', 'embed-resource-3.0.12'):
            shutil.copytree(ROOT / 'vendor' / name, self.source / 'vendor' / name,
                            ignore=shutil.ignore_patterns('*.md', '*.MD', '__pycache__'))

    def test_snapshot_reports_and_blocks_every_mutation(self):
        import contextlib
        import io
        import json
        fixture = self.stage / 'snapshot-fixture'
        fixture.mkdir()
        (fixture / 'changed.rs').write_text('original')
        (fixture / 'removed.rs').write_text('original')
        before = layout.source_snapshot(fixture)
        layout.verify_source_snapshot(fixture, before, 'analysis')
        (fixture / 'changed.rs').write_text('changed')
        (fixture / 'removed.rs').unlink()
        (fixture / 'generated.json').write_text('{}')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaisesRegex(ValueError, 'analysis modified actual source inputs'):
                layout.verify_source_snapshot(fixture, before, 'analysis')
        report = json.loads(output.getvalue())
        self.assertEqual(report['source_mutations'], dict(
            added=['generated.json'], removed=['removed.rs'], changed=['changed.rs']))
        self.assertFalse(report['release_approved'])

    def test_targets_sources_and_lock_are_preserved(self):
        rust = {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.source.rglob('*.rs')}
        lock = (self.source / 'Cargo.lock').read_bytes()
        original = tomllib.loads((self.source / 'vendor/glib-0.18.5/Cargo.toml').read_text())
        metadata = self.stage / 'analysis-manifests'
        self.assertEqual(len(layout.relocate(self.source, metadata)), 2)
        self.assertEqual((self.source / 'Cargo.lock').read_bytes(), lock)
        self.assertEqual(rust, {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in self.source.rglob('*.rs')})
        root = tomllib.loads((self.source / 'Cargo.toml').read_text())
        for package in ('glib', 'embed-resource'):
            path = Path(root['patch']['crates-io'][package]['path'])
            self.assertFalse(path.is_relative_to(self.source))
            manifest = tomllib.loads((path / 'Cargo.toml').read_text())
            self.assertTrue(Path(manifest['lib']['path']).is_file())
            self.assertEqual(manifest['dependencies'], tomllib.loads((ROOT / 'vendor' / path.name / 'Cargo.toml').read_text())['dependencies'])
        glib = tomllib.loads((metadata / 'glib-0.18.5/Cargo.toml').read_text())
        expected = {p.stem for p in (self.source / 'vendor/glib-0.18.5/tests').glob('*.rs')}
        self.assertEqual({row['name'] for row in glib['test']}, expected)
        self.assertEqual(next(row for row in glib['test'] if row['name'] == 'subclass_compiletest')['required-features'],
                         original['test'][0]['required-features'])
        for row in glib['test'] + glib['bench']:
            self.assertTrue(Path(row['path']).is_file())
        self.assertFalse((self.source / 'vendor/glib-0.18.5/Cargo.toml').exists())
        self.assertFalse((self.source / 'vendor/embed-resource-3.0.12/Cargo.toml').exists())

    def test_changed_root_override_is_rejected(self):
        path = self.source / 'Cargo.toml'
        path.write_text(path.read_text().replace('vendor/glib-0.18.5', 'unexpected/glib'))
        with self.assertRaisesRegex(ValueError, 'root path override'):
            layout.relocate(self.source, self.stage / 'analysis-manifests')

    def test_changed_vendor_target_is_rejected(self):
        path = self.source / 'vendor/glib-0.18.5/Cargo.toml'
        path.write_text(path.read_text().replace('name = "glib"', 'name = "changed"'))
        with self.assertRaisesRegex(ValueError, 'GLib library target'):
            layout.relocate(self.source, self.stage / 'analysis-manifests')


class BodyCoverageTests(unittest.TestCase):
    def result(self):
        return {'#select': {'tuples': [list(pair) for pair in sorted(layout.BODY_EXPECTED)]}}

    def test_actual_source_pairs_and_windows_paths(self):
        result = self.result()
        for row in result['#select']['tuples']:
            row[0] = 'C:\\reviewed\\source\\' + row[0].replace('/', '\\')
        self.assertEqual(set(layout.validate_bodies(result)), layout.BODY_EXPECTED)

    def test_missing_auth_function_is_not_coverage(self):
        result = self.result()
        result['#select']['tuples'].pop()
        with self.assertRaisesRegex(ValueError, 'missing actual'):
            layout.validate_bodies(result)

    def test_duplicate_actual_body_rejects(self):
        result = self.result()
        result['#select']['tuples'].append(result['#select']['tuples'][0])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            layout.validate_bodies(result)

    def test_same_name_in_other_dependency_is_not_coverage(self):
        result = self.result()
        result['#select']['tuples'][0][0] = 'registry/dependency/src/lib.rs'
        with self.assertRaisesRegex(ValueError, 'missing actual'):
            layout.validate_bodies(result)


class SourceSnapshotTests(unittest.TestCase):
    def test_changes_and_added_files_are_observable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'Cargo.toml').write_text('[workspace]\n')
            before = layout.source_snapshot(root)
            (root / 'Cargo.toml').write_text('[package]\n')
            self.assertNotEqual(layout.source_snapshot(root), before)
            (root / 'Cargo.toml').write_text('[workspace]\n')
            (root / 'injected.rs').write_text('fn injected() {}\n')
            self.assertNotEqual(layout.source_snapshot(root), before)

    def test_source_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'source.rs').write_text('fn original() {}\n')
            (root / 'alias.rs').symlink_to(root / 'source.rs')
            with self.assertRaisesRegex(ValueError, 'source symlink'):
                layout.source_snapshot(root)


class NativeApprovalLayoutTests(unittest.TestCase):
    def test_existing_review_is_copied_without_expanding_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = root / 'native/windows/compile-approval.json'
            original.parent.mkdir(parents=True)
            original.write_bytes((ROOT / 'native/windows/compile-approval.json').read_bytes())
            proof = layout.stage_native_approval(root)
            self.assertEqual((root / proof['path']).read_bytes(), original.read_bytes())
            self.assertEqual(proof['sha256'], hashlib.sha256(original.read_bytes()).hexdigest())
            with self.assertRaisesRegex(ValueError, 'fresh'):
                layout.stage_native_approval(root)

    def test_changed_review_is_rejected_before_it_can_satisfy_build_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = root / 'native/windows/compile-approval.json'
            original.parent.mkdir(parents=True)
            original.write_bytes(b'{"approved":true}')
            with self.assertRaisesRegex(ValueError, 'changed'):
                layout.stage_native_approval(root)
            self.assertFalse((root / '.security-review').exists())


class StitchedSysrootTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='stellar-sysroot-layout-')
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)
        self.root = self.parent / 'sysroot'
        self.root.mkdir()
        self.manifest = self.root / 'Cargo.toml'
        self.manifest.write_text('[workspace]\nmembers=[]\n')
        self.retained = self.parent / 'retained-Cargo.toml'

    def test_changed_manifest_cannot_select_an_analysis_graph(self):
        with self.assertRaisesRegex(ValueError, 'manifest changed'):
            layout.prepare_stitched_sysroot(self.root, self.retained)
        self.assertTrue(self.manifest.exists())
        self.assertFalse(self.retained.exists())

    def test_existing_destination_cannot_be_overwritten(self):
        self.retained.write_text('keep original')
        with self.assertRaisesRegex(ValueError, 'manifest layout'):
            layout.prepare_stitched_sysroot(self.root, self.retained)
        self.assertEqual(self.retained.read_text(), 'keep original')

    def test_manifest_link_is_not_followed(self):
        self.manifest.unlink()
        self.manifest.symlink_to(ROOT / 'Cargo.toml')
        with self.assertRaisesRegex(ValueError, 'manifest layout'):
            layout.prepare_stitched_sysroot(self.root, self.retained)

    def test_retained_manifest_must_be_outside_sysroot(self):
        with self.assertRaisesRegex(ValueError, 'manifest layout'):
            layout.prepare_stitched_sysroot(self.root, self.root / 'retained.toml')


class CompilerResourcePathTests(unittest.TestCase):
    def test_original_long_layout_is_rejected_before_compiler_execution(self):
        path = r'C:\Users\runneradmin\AppData\Local\Temp\stellar-app-analysis-lyti2coz\stellar-codeql-stage-f6e8b06913664e8e9710fa27f9d070e8'
        with self.assertRaisesRegex(ValueError, 'resource-loader budget'):
            layout.native_resource_path_budget(path)

    def test_short_owned_layout_retains_headroom_for_compiler_resources(self):
        path = r'C:\Users\runneradmin\AppData\Local\Temp\s-abcdefgh\q-0123456789ab'
        result = layout.native_resource_path_budget(path)
        self.assertLess(result['projected_native_resource_path_chars'], result['limit_chars'])


if __name__ == '__main__':
    unittest.main()
