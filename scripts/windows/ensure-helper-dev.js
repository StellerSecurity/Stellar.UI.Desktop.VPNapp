const { spawnSync } = require('child_process');
const path = require('path');

if (process.platform !== 'win32') {
  process.exit(0);
}

const script = path.join(__dirname, 'ensure-helper-dev.ps1');
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
  stdio: 'inherit',
  windowsHide: false,
});

process.exit(result.status ?? 1);
