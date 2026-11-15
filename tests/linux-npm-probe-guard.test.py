"""Exercise tool-process bounds with trusted Python only, never npm/Node."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('probe_guard', ROOT / 'scripts/linux-npm-backport-probe.py')
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.original_root = probe.ROOT
        probe.ROOT = self.work
        self.addCleanup(setattr, probe, 'ROOT', self.original_root)

    def command(self, code):
        return [sys.executable, '-I', '-c', code]

    def test_bounded_success(self):
        self.assertEqual(probe.run(self.command("print('bounded')"), self.work,
                                   dict(PATH=os.defpath)), 'bounded\n')

    def test_failed_command_does_not_pass(self):
        with self.assertRaisesRegex(ValueError, 'exit 7'):
            probe.run(self.command('raise SystemExit(7)'), self.work, dict(PATH=os.defpath))

    def test_output_overflow_stops_process(self):
        with self.assertRaisesRegex(ValueError, 'output limit'):
            probe.run(self.command("print('x' * (129 * 1024))"), self.work, dict(PATH=os.defpath))

    def test_timeout_stops_process_group(self):
        with self.assertRaisesRegex(ValueError, 'time limit'):
            probe.run(self.command('while True: pass'), self.work, dict(PATH=os.defpath), timeout=0.15)


if __name__ == '__main__':
    unittest.main()
