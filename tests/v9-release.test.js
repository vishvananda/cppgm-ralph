import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('V9 release tags and scaffold preparation are gated without mutating the old run', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_v9_release.py'],
    { cwd: process.cwd(), stdio: 'pipe', timeout: 30000 });
});

test('V9 student sidecars fit native goals and omit optional PA38', () => {
  execFileSync(process.execPath, ['examples/v9sol/verify-setup.mjs'], { stdio: 'pipe', timeout: 30000 });
});
