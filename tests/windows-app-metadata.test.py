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


if __name__ == '__main__':
    unittest.main()
