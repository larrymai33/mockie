import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QueueWorker, type ExecutionOptions } from './runner.js';

export async function checkHealth(root: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8')) as { updatedAt?: string; pid?: number };
    const age = Date.now() - Date.parse(record.updatedAt ?? '');
    if (!Number.isFinite(age) || age < 0 || age > 15_000 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0) return false;
    process.kill(record.pid!, 0);
    return true;
  } catch { return false; }
}

export async function runWorker(root: string, signal: AbortSignal, options: ExecutionOptions & { pollMs?: number } = {}) {
  const worker = new QueueWorker(root, options);
  await worker.initialize();
  try {
    while (!signal.aborted) {
      await worker.runOnce();
      try { await delay(options.pollMs ?? 150, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  } finally {
    // Graceful stop drains the active bounded job, then invalidates the healthcheck.
    await unlink(join(root, 'heartbeat.json')).catch(() => {});
  }
}
