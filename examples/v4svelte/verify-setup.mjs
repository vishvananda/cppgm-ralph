import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSessionIsolationSpawn } from '../../session-isolation.js';
import { buildSystemdScopeSpawn } from '../../systemd-scope.js';

const configPath = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const stateDir = path.join(config.stateBaseDir, `${config.name}-${config.model}-${config.reasoningEffort}`);
const artifactDir = path.join(config.sessionIsolation.privateWriteDir, 'artifacts/scaffold-verification');
fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
const probe = path.join(artifactDir, 'probe.py');
fs.writeFileSync(probe, 'n=1\nfor i in range(2000000): n=(n*1664525+1013904223)&0xffffffff\nassert n>=0\n');
const shell = `set -eu
python3 -c 'import os; assert 24 in os.sched_getaffinity(0)'
perf stat -x ';' -o '${artifactDir}/counts.txt' -e '{instructions:u,cycles:u}' -- taskset -c 24 python3 '${probe}'
perf record -e cycles:u -F 99 --call-graph dwarf,8192 -o '${artifactDir}/perf.data' -- taskset -c 24 python3 '${probe}'
perf report --stdio -i '${artifactDir}/perf.data' > '${artifactDir}/profile.txt'
perl scripts/cppgm_file_audit.pl --stage pa1 --paths dev/src
`;
const isolated = buildSessionIsolationSpawn('/bin/sh', ['-c', shell], {
  isolation: config.sessionIsolation, cwd: config.workdir,
  privateWriteSettings: { workdir: config.workdir, stateDir },
});
const scoped = buildSystemdScopeSpawn(isolated.command, isolated.args, {
  enabled: true, memoryMax: '64G', memorySwapMax: '0', oomGroup: false, cleanupTimeoutSec: 2,
});
const result = spawnSync(scoped.command, scoped.args, { encoding: 'utf8' });
fs.writeFileSync(path.join(artifactDir, 'verification.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
const rows = fs.readFileSync(path.join(artifactDir, 'counts.txt'), 'utf8')
  .split('\n').map(line => line.split(';'))
  .filter(row => ['instructions:u', 'cycles:u'].includes(row[2]));
assert.equal(rows.length, 2, 'Both grouped hardware events must be available');
for (const row of rows) {
  assert(Number(row[0]) > 0, `Missing count for ${row[2]}`);
  assert.equal(Number(row[4]), 100, `Multiplexed event: ${row[2]}`);
}
assert(fs.statSync(path.join(artifactDir, 'perf.data')).size > 0);
assert(fs.readFileSync(path.join(artifactDir, 'profile.txt'), 'utf8').includes('cycles:u'));
console.log(`Sandbox, 64 GiB scope, file audit and hardware counters verified: ${artifactDir}`);
