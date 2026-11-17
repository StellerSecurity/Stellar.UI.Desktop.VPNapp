"""Export must fail before output when any frozen identity is incomplete."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build-reviewed-esbuild.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.destination = self.root / 'export'
        self.rows, self.expected = [], {}
        for target_os in ('darwin', 'linux', 'windows'):
            for arch in ('arm64', 'amd64'):
                raw = (target_os + '/' + arch).encode()
                sha = hashlib.sha256(raw).hexdigest()
                (self.source / ('esbuild-' + target_os + '-' + arch)).write_bytes(raw)
                self.expected[target_os + '/' + arch] = sha
                self.rows.append(dict(os=target_os, arch=arch, bytes=len(raw), sha256=sha,
                                      independent_rebuild_matches_previous=True))

    def export(self):
        return builder.export_reviewed_runtimes(self.rows, self.source, self.destination, self.expected)

    def test_complete_export_and_no_overwrite(self):
        result = self.export()
        self.assertEqual(len(result), 6)
        self.assertTrue((self.destination / 'runtime-manifest.json').is_file())
        with self.assertRaisesRegex(ValueError, 'fresh absolute'):
            self.export()

    def test_changed_runtime_rejected_before_output(self):
        (self.source / 'esbuild-linux-arm64').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'identity drift'):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_incomplete_target_set_rejected(self):
        self.rows.pop()
        with self.assertRaisesRegex(ValueError, 'six-target'):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_unreproduced_target_rejected(self):
        self.rows[0]['independent_rebuild_matches_previous'] = False
        with self.assertRaisesRegex(ValueError, 'independent reproduction'):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_symlink_input_rejected(self):
        original = self.source / 'esbuild-darwin-arm64'
        alternate = self.root / 'alias-target'
        original.rename(alternate)
        original.symlink_to(alternate)
        with self.assertRaisesRegex(ValueError, 'regular bounded'):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_symlink_parent_rejected(self):
        alias = self.root / 'parent-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.destination = alias / 'export'
        with self.assertRaisesRegex(ValueError, 'fresh absolute'):
            self.export()
        self.assertFalse((self.root / 'export').exists())


if __name__ == '__main__':
    unittest.main()
