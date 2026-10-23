import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHealth, runWorker } from './service.js';

const temporary: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'mockie-health-test-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it('health fails before startup and with a stale heartbeat', async () => {
  const root = await temp();
  expect(await checkHealth(root)).toBe(false);
  await writeFile(join(root, 'heartbeat.json'), JSON.stringify({ updatedAt: new Date(0).toISOString(), pid: process.pid }));
  expect(await checkHealth(root)).toBe(false);
});

it('publishes a live heartbeat and stops cleanly on abort', async () => {
  const root = await temp();
  const controller = new AbortController();
  const service = runWorker(root, controller.signal, { pollMs: 5 });
  await expect.poll(async () => checkHealth(root)).toBe(true);
  expect(JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8')).pid).toBe(process.pid);
  controller.abort();
  await service;
  expect(await checkHealth(root)).toBe(false);
});
