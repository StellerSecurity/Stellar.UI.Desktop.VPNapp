"""Exercise the source-only staging boundary with the exact cached Rust input."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sysroot_stager', ROOT / 'scripts/stage-reviewed-rust-sysroot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PROFILE = json.loads((ROOT / 'native/codeql/rust-sysroot-source-inputs.json').read_bytes())


class Response(io.BytesIO):
    status = 200
    headers = {}
    def geturl(self):
        return module.URL


class SourceStageTests(unittest.TestCase):
    def test_exact_profile(self):
        self.assertEqual(len(module.validate_profile(PROFILE)), 2356)

    def test_traversal_rejected(self):
        profile = copy.deepcopy(PROFILE)
        profile['files'][0]['path'] = '../escape'
        with self.assertRaisesRegex(ValueError, 'source path'):
            module.validate_profile(profile)

    def test_windows_case_collision_rejected(self):
        profile = copy.deepcopy(PROFILE)
        profile['files'][1]['path'] = profile['files'][0]['path'].swapcase()
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            module.validate_profile(profile)

    def test_vendor_package_is_not_implicitly_approved(self):
        profile = copy.deepcopy(PROFILE)
        profile['files'][0]['path'] = 'vendor/unknown/src/lib.rs'
        with self.assertRaisesRegex(ValueError, 'unreviewed'):
            module.validate_profile(profile)

    def test_existing_destination_rejects_before_network(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(module.urllib.request, 'build_opener', side_effect=AssertionError('network must not start')):
            with self.assertRaisesRegex(ValueError, 'fresh'):
                module.stage_source(Path(folder), PROFILE)

    def test_exact_cached_source_staging_without_target_execution(self):
        archive = ROOT.parent / 'rust-source-review-data/rust-src-1.99.1.tar.xz'
        raw = archive.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), module.ARCHIVE_SHA)
        class Opener:
            def open(self, request, timeout):
                if request.full_url != module.URL:
                    raise AssertionError('unexpected source URL')
                return Response(raw)
        with tempfile.TemporaryDirectory() as folder, patch.object(module.urllib.request, 'build_opener', return_value=Opener()):
            destination = Path(folder) / 'source'
            result = module.stage_source(destination, PROFILE)
            self.assertEqual(result['source_files'], 2356)
            self.assertFalse((destination / 'vendor').exists())
            self.assertFalse(list(destination.rglob('*.auxv')))
            for row in PROFILE['files']:
                self.assertEqual(hashlib.sha256((destination / row['path']).read_bytes()).hexdigest(), row['sha256'])
            for name in ('core/src/lib.rs', 'alloc/src/lib.rs', 'std/src/lib.rs'):
                self.assertTrue((destination / name).is_file())
            self.assertFalse(result['binaries_staged'])
            self.assertFalse(result['installer_executed'])
            self.assertFalse(result['sdk_modified'])


if __name__ == '__main__':
    unittest.main()
