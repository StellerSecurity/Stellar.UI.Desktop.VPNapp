"""Regress the real Windows short/long-path mismatch without running CodeQL."""
import ctypes
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve()
runner = HERE.with_name('windows-app-metadata.py')
if not runner.is_file():
    runner = HERE.parents[1] / 'scripts/windows-app-metadata.py'
spec = importlib.util.spec_from_file_location('firstparty_analysis_paths', runner)
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class AnalysisPathTests(unittest.TestCase):
    def test_existing_aliases_are_canonical_before_pack_paths_are_formed(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            stage = work / 'owned-stage'
            source = stage / 'source'
            source.mkdir(parents=True)
            actual_source, actual_stage = analysis.canonical_analysis_roots(work, source / '..' / 'source', stage)
            self.assertEqual(actual_source, source.resolve())
            self.assertEqual(actual_stage, stage.resolve())
            self.assertEqual(actual_source.parent, actual_stage)

    def test_outside_owner_and_inconsistent_stage_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            owner = root / 'owner'
            outside = root / 'other/source'
            owner.mkdir()
            outside.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'canonical'):
                analysis.canonical_analysis_roots(owner, outside, outside.parent)
            source = owner / 'stage/source'
            source.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'canonical'):
                analysis.canonical_analysis_roots(owner, source, owner)

    @unittest.skipUnless(os.name == 'nt', 'requires the native Windows 8.3 path API')
    def test_real_windows_short_alias_cannot_escape_its_long_pack_root(self):
        with tempfile.TemporaryDirectory(prefix='stellar-path-regression-') as folder:
            work = Path(folder).resolve(strict=True)
            stage = work / 'long-analysis-directory'
            source = stage / 'source'
            source.mkdir(parents=True)
            function = ctypes.WinDLL('kernel32', use_last_error=True).GetShortPathNameW
            function.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
            function.restype = ctypes.c_uint32
            buffer = ctypes.create_unicode_buffer(32768)
            count = function(str(source), buffer, len(buffer))
            self.assertTrue(0 < count < len(buffer), 'native short-path lookup must succeed')
            short_source = Path(buffer.value)
            if short_source == source:
                self.skipTest('this volume has no short alias for the regression fixture')
            actual_source, actual_stage = analysis.canonical_analysis_roots(work, short_source, stage)
            self.assertEqual(actual_source, source)
            self.assertEqual(actual_stage, stage)
            query = actual_source / 'queries/security/fixture.ql'
            self.assertEqual(query.relative_to(actual_source).as_posix(), 'queries/security/fixture.ql')


if __name__ == '__main__':
    unittest.main()
