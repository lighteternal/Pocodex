/** Measure the real Electron process group without touching the user's profile. */
const { _electron: electron } = require('../companion/node_modules/@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pocodex-measure-'));
  const source = path.join(profile, 'source'); await fs.mkdir(path.join(source, 'sessions'), { recursive: true });
  execFileSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/seed_pocodex_demo.py'), profile, path.join(root, 'companion/assets')]);
  const application = await electron.launch({
    ...(process.env.POCODEX_EXECUTABLE ? { executablePath: process.env.POCODEX_EXECUTABLE } : {}),
    args: [...(process.env.POCODEX_EXECUTABLE ? [] : [path.join(root, 'companion')]), `--profile=${profile}`, `--source=${source}`, ...process.argv.slice(3)],
  });
  const duration = Number(process.argv[2] || 300);
  const samples = [];
  const pid = await application.evaluate(() => process.pid);
  const started = performance.now();
  let previous;
  try {
    for (let second = 0; second <= duration; second += 15) {
      if (second) await new Promise(resolve => setTimeout(resolve, Math.max(0, started + second * 1000 - performance.now())));
      const script = `$ids = [System.Collections.Generic.List[int]]::new(); $ids.Add(${pid}); for ($i=0; $i -lt $ids.Count -and $i -lt 30; $i++) { Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $ids[$i]) | ForEach-Object { $ids.Add($_.ProcessId) } }; @(Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,@{Name='CpuSeconds';Expression={$_.TotalProcessorTime.TotalSeconds}}) | ConvertTo-Json -Compress`;
      const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }));
      const elapsed = (performance.now() - started) / 1000;
      const cpuSeconds = rows.reduce((n,p) => n + p.CpuSeconds, 0);
      const point = { elapsed, cpu: previous ? 100 * (cpuSeconds - previous.cpuSeconds) / (elapsed - previous.elapsed) : null, cpuSeconds, workingSetMB: rows.reduce((n,p) => n + p.WorkingSet64, 0) / 1048576, privateMB: rows.reduce((n,p) => n + p.PrivateMemorySize64, 0) / 1048576, processes: rows.length, breakdown: rows };
      previous = point;
      samples.push(point); console.log(JSON.stringify(point));
    }
    await fs.writeFile(path.resolve(root, process.env.POCODEX_PERF_OUTPUT || 'artifacts/pocodex-performance.json'), JSON.stringify({ measured: new Date().toISOString(), platform: os.release(), cpu: os.cpus()[0].model, executable: process.env.POCODEX_EXECUTABLE ? 'packaged' : 'development', flags: process.argv.slice(3), scope: 'Actual Electron main PID and all descendants including Python, excluding launch harness; summed working set may double count shared pages; privateMB is private committed memory; CPU percent of one logical core; seeded idle buddy without opening Home', samples }, null, 2));
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
