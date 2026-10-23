import { checkHealth, runWorker } from './service.js';

const queueRoot = process.env.RUNNER_QUEUE_DIR ?? '/queue';
if (process.argv[2] === 'healthcheck') {
  process.exitCode = await checkHealth(queueRoot) ? 0 : 1;
} else {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('The runner service requires the Linux sandbox image and root supervisor; candidate code runs as UID/GID 65534.');
  }
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  await runWorker(queueRoot, controller.signal, {
    childUid: integer('RUNNER_CHILD_UID', 65534, 2_147_483_647),
    childGid: integer('RUNNER_CHILD_GID', 65534, 2_147_483_647),
    timeoutMs: integer('RUNNER_TIMEOUT_MS', 5000, 10_000),
    outputLimitBytes: integer('RUNNER_OUTPUT_LIMIT_BYTES', 65_536, 65_536),
  });
}
