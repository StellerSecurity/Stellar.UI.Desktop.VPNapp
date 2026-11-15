"""Reject altered sources, implicit dependencies and installed query binaries."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reviewed_queries', ROOT / 'scripts/stage-reviewed-rust-queries.py')
queries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queries)


class QueryStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sdk = self.root / 'sdk'
        self.destination = self.root / 'source'
        self.profile = dict(files=[], manifests=[])
        for name, deps in [('query', '  codeql/library: 1.0.0\n'), ('library', None)]:
            folder = self.sdk / name / '1.0.0'
            folder.mkdir(parents=True)
            manifest = '---\nname: codeql/' + name + '\nversion: 1.0.0\n'
            manifest += 'dependencies:\n' + deps if deps else 'dependencies: {}\n'
            (folder / 'qlpack.yml').write_bytes(manifest.encode())
            self.profile['manifests'].append(dict(package=name, version='1.0.0', manifest=manifest))
            data = b'// synthetic first-party query input\n'
            (folder / 'main.qll').write_bytes(data)
            self.profile['files'].append(dict(package=name, version='1.0.0', path='main.qll', bytes=len(data),
                                             sha256=hashlib.sha256(data).hexdigest(),
                                             git_blob_sha1=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()))

    def stage(self):
        return queries.stage_source(self.sdk, self.destination, self.profile, expected_files=2, expected_packs=2)

    def test_only_verified_source_and_uncompiled_locks_are_staged(self):
        (self.sdk / 'query/1.0.0/injected.qlx').write_bytes(b'not reviewed')
        (self.sdk / 'query/1.0.0/guide.md').write_text('not an input')
        result = self.stage()
        self.assertEqual(result['source_files'], 2)
        self.assertFalse(list(self.destination.rglob('*.qlx')))
        self.assertFalse(list(self.destination.rglob('*.md')))
        lock = (self.destination / 'query/codeql-pack.lock.yml').read_text()
        self.assertIn('codeql/library:\n    version: 1.0.0\n', lock)
        self.assertTrue(lock.endswith('compiled: false\n'))

    def test_source_mutation_rejects_before_destination_creation(self):
        (self.sdk / 'query/1.0.0/main.qll').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.stage()
        self.assertFalse(self.destination.exists())

    def test_git_identity_mismatch_rejects(self):
        self.profile['files'][0]['git_blob_sha1'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.stage()

    def test_case_alias_rejects(self):
        self.profile['files'].append(copy.deepcopy(self.profile['files'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.stage()

    def test_traversal_and_compiled_input_reject(self):
        for name in ('../escape.qll', 'foo.qlx', '.codeql/input.qll', 'guide.Md'):
            with self.subTest(name=name):
                self.profile['files'][0]['path'] = name
                with self.assertRaisesRegex(ValueError, 'non-source'):
                    self.stage()

    def test_unbound_dependency_rejects(self):
        row = self.profile['manifests'][0]
        row['manifest'] = row['manifest'].replace('library: 1.0.0', 'unknown: 1.0.0')
        (self.sdk / 'query/1.0.0/qlpack.yml').write_bytes(row['manifest'].encode())
        with self.assertRaisesRegex(ValueError, 'unbound'):
            self.stage()

    def test_source_symlink_rejects(self):
        source = self.sdk / 'query/1.0.0/main.qll'
        source.rename(source.with_suffix('.original'))
        source.symlink_to(source.with_suffix('.original'))
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.stage()

    def test_existing_destination_rejects(self):
        self.destination.mkdir()
        with self.assertRaisesRegex(ValueError, 'fresh'):
            self.stage()


if __name__ == '__main__':
    unittest.main()
