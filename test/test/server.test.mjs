import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function start(env) {
  const child = spawn(process.execPath, ['src/src/server.mjs'], { cwd: process.cwd(),
    env: { ...process.env, BITRIX24_WEBHOOK_URL: 'https://invalid.example.test/rest/1/test/',
      SCORING_SECRET: 'test-secret', POLL_INTERVAL_MS: '0', PORT: '0', LEGAL_ARCHIVE_ENABLED: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Server startup timeout')); }, 5000);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Server exited during startup: ' + code)); });
    child.stdout.on('data', bytes => {
      logs += bytes.toString();
      const match = /listening on (\d+)/.exec(logs);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  return { child, base: `http://127.0.0.1:${port}`, logs: () => logs };
}

for (const enabled of [false, true]) test(`CRM HTTP routes survive with archive ${enabled ? 'misconfigured' : 'disabled'}`, async () => {
  const instance = await start({ LEGAL_ARCHIVE_ENABLED: String(enabled), LEGAL_ARCHIVE_WEBHOOK_URL: 'invalid' });
  try {
    assert.deepEqual(await (await fetch(instance.base + '/health')).json(), { ok: true });
    const unauthorized = await fetch(instance.base + '/bitrix/scoring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 403);
    const incomplete = await fetch(instance.base + '/bitrix/scoring', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-scoring-secret': 'test-secret' }, body: '{}' });
    assert.equal(incomplete.status, 400);
    if (enabled) assert.match(instance.logs(), /configuration_error/);
    assert.doesNotMatch(instance.logs(), /https:|test-secret/);
  } finally {
    const exited = once(instance.child, 'exit');
    instance.child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  }
});
