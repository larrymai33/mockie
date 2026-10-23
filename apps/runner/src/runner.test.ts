import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommand, executeJob, parseJob, QueueWorker, type ExecutionOptions } from './runner.js';

const temporary: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'mockie-runner-test-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const job = (code = 'console.log("hello")') => ({
  id: 'job-1', sessionId: 'session-1', language: 'javascript' as const,
  code, createdAt: '2026-10-22T12:00:00.000Z',
});
// The platform seam bypasses Linux rlimits, but all process IO/timers/queue behavior is real.
const local: ExecutionOptions = { commandBuilder: (_language, file) => ({ executable: process.execPath, args: [file] }), childUid: undefined, childGid: undefined };

describe('job validation', () => {
  it('accepts optional stdin and clamps a caller timeout to the supervisor limit', async () => {
    expect(parseJob({ ...job(), stdin: 'hello', timeoutMs: 100 }).stdin).toBe('hello');
    const result = await executeJob({ ...job('setInterval(() => {}, 1000)'), timeoutMs: 60_000 }, { ...local, timeoutMs: 120 });
    expect(result.status).toBe('timeout');
    expect(result.durationMs).toBeLessThan(3000);
  });
  it.each([
    { ...job(), language: 'bash' }, { ...job(), id: '../escape' },
    { ...job(), createdAt: 'invalid' }, { ...job(), stdin: 4 },
    { ...job(), code: 'x'.repeat(65_537) }, { ...job(), timeoutMs: -1 },
    { ...job(), sessionId: '' },
  ])('rejects invalid and unsafe queue input %#', (value) => {
    expect(() => parseJob(value)).toThrow();
  });
  it('rejects unsupported languages without executing supplied code', async () => {
    const result = await executeJob({ ...job('throw new Error("should not run")'), language: 'bash' }, local);
    expect(result.status).toBe('rejected');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBeNull();
  });
});

describe('argv construction', () => {
  it('wraps a fixed interpreter with CPU, memory, file and process rlimits', () => {
    const command = buildCommand('javascript', '/tmp/code;$(touch injected).js');
    expect(command.executable).toBe('/usr/bin/setpriv');
    expect(command.args).toEqual([
      '--reuid=65534', '--regid=65534', '--clear-groups', '--inh-caps=-all',
      '--ambient-caps=-all', '--no-new-privs', '--', '/usr/bin/prlimit',
      '--cpu=3:3', '--as=2147483648:2147483648', '--fsize=1048576:1048576',
      '--nproc=32:32', '--nofile=64:64', '--core=0:0', '--',
      '/usr/local/bin/node', '--max-old-space-size=64', '--jitless', '/tmp/code;$(touch injected).js',
    ]);
    expect(buildCommand('python', '/tmp/program.py').args.slice(-4)).toEqual(['/usr/bin/python3', '-I', '-B', '/tmp/program.py']);
    expect(() => buildCommand('sh' as 'python', '/tmp/code')).toThrow();
  });
  it('uses configured child identity and rejects supervisor root as the child', () => {
    expect(buildCommand('python', '/tmp/main.py', { uid: 12345, gid: 12346 }).args.slice(0, 3)).toEqual(['--reuid=12345', '--regid=12346', '--clear-groups']);
    expect(() => buildCommand('python', '/tmp/main.py', { uid: 0, gid: 0 })).toThrow();
  });
});

describe('bounded execution', () => {
  it('runs JavaScript successfully with piped stdin', async () => {
    const result = await executeJob({ ...job('process.stdin.on("data", b => process.stdout.write(b));'), stdin: 'hello\n' }, local);
    expect(result).toMatchObject({ jobId: 'job-1', sessionId: 'session-1', status: 'success', stdout: 'hello\n', stderr: '', exitCode: 0, truncated: false });
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(Date.parse(result.completedAt)).not.toBeNaN();
  });
  it('captures a runtime exception as an error result', async () => {
    const result = await executeJob(job('throw new Error("candidate failure")'), local);
    expect(result.status).toBe('error');
    expect(result.stderr).toContain('candidate failure');
    expect(result.exitCode).not.toBe(0);
  });
  it('kills a hanging process on wall timeout', async () => {
    const result = await executeJob(job('while (true) {}'), { ...local, timeoutMs: 150 });
    expect(result.status).toBe('timeout');
    expect(result.durationMs).toBeLessThan(3000);
  });
  it('bounds stdout and stderr independently and signals truncation', async () => {
    const result = await executeJob(job('process.stdout.write("o".repeat(100000)); process.stderr.write("e".repeat(100000));'), { ...local, outputLimitBytes: 1024 });
    expect(result.status).toBe('success');
    expect(Buffer.byteLength(result.stdout)).toBe(1024);
    expect(Buffer.byteLength(result.stderr)).toBe(1024);
    expect(result.truncated).toBe(true);
  });
  it('bounds UTF-8 output without replacement characters extending the byte limit', async () => {
    const result = await executeJob(job('process.stdout.write("😀".repeat(3000))'), { ...local, outputLimitBytes: 1025 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1025);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.truncated).toBe(true);
  });
  it('does not leak supervisor environment variables into code', async () => {
    process.env.MOCKIE_TEST_SECRET = 'do-not-leak';
    try {
      const result = await executeJob(job('console.log(process.env.MOCKIE_TEST_SECRET ?? "absent")'), local);
      expect(result.stdout).toBe('absent\n');
    } finally { delete process.env.MOCKIE_TEST_SECRET; }
  });
  it('turns interpreter startup errors into a recoverable result', async () => {
    const result = await executeJob(job(), { ...local, commandBuilder: () => ({ executable: '/missing/mockie-interpreter', args: [] }) });
    expect(result.status).toBe('error');
    expect(result.exitCode).toBeNull();
  });
});

describe('file queue', () => {
  it('claims jobs and atomically publishes one result with no temporary files left', async () => {
    const root = await temp();
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    await writeFile(join(root, 'jobs', 'job-1.json'), JSON.stringify(job()));
    expect(await worker.runOnce()).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'results', 'job-1.json'), 'utf8'))).toMatchObject({ jobId: 'job-1', status: 'success', stdout: 'hello\n' });
    expect(await readdir(join(root, 'processing'))).toEqual([]);
    expect(await readdir(join(root, 'results'))).toEqual(['job-1.json']);
    expect(JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8')).updatedAt).toBeTypeOf('string');
  });
  it('serializes overlapping polling calls to one subprocess at a time', async () => {
    const root = await temp();
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    await writeFile(join(root, 'jobs', 'job-1.json'), JSON.stringify(job('setTimeout(() => console.log("one"), 80)')));
    await writeFile(join(root, 'jobs', 'job-2.json'), JSON.stringify({ ...job(), id: 'job-2' }));
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(await readdir(join(root, 'jobs'))).toEqual(['job-2.json']);
    expect(await worker.runOnce()).toBe(true);
  });
  it('returns a recoverable error for interrupted processing without rerunning candidate code', async () => {
    const root = await temp();
    await mkdir(join(root, 'processing'), { recursive: true });
    await writeFile(join(root, 'processing', 'job-1.json'), JSON.stringify(job('console.log("must not reexecute")')));
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, 'processing', 'job-1.json'), old, old);
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    const result = JSON.parse(await readFile(join(root, 'results', 'job-1.json'), 'utf8'));
    expect(result.status).toBe('error');
    expect(result.stderr).toMatch(/interrupted/i);
    expect(result.stdout).toBe('');
    expect(await readdir(join(root, 'processing'))).toEqual([]);
  });
  it('preserves a published result when processing cleanup was interrupted', async () => {
    const root = await temp();
    await mkdir(join(root, 'processing'), { recursive: true });
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'processing', 'job-1.json'), JSON.stringify(job()));
    await writeFile(join(root, 'results', 'job-1.json'), JSON.stringify({ status: 'success', stdout: 'original' }));
    await new QueueWorker(root, local).initialize();
    expect(JSON.parse(await readFile(join(root, 'results', 'job-1.json'), 'utf8')).stdout).toBe('original');
  });
  it('never reexecutes a duplicate job whose result has already been published', async () => {
    const root = await temp();
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    const marker = join(root, 'duplicate-ran');
    await writeFile(join(root, 'results', 'job-1.json'), JSON.stringify({ status: 'success', stdout: 'original' }));
    await writeFile(join(root, 'jobs', 'job-1.json'), JSON.stringify(job(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)));
    expect(await worker.runOnce()).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
  });
  it('rejects malformed JSON then continues with the next valid job', async () => {
    const root = await temp();
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    await writeFile(join(root, 'jobs', 'bad.json'), '{bad');
    await writeFile(join(root, 'jobs', 'job-1.json'), JSON.stringify(job()));
    await worker.runOnce();
    expect(JSON.parse(await readFile(join(root, 'results', 'bad.json'), 'utf8')).status).toBe('rejected');
    await worker.runOnce();
    expect(JSON.parse(await readFile(join(root, 'results', 'job-1.json'), 'utf8')).status).toBe('success');
  });
  it('rejects a queue filename and job id mismatch', async () => {
    const root = await temp();
    const worker = new QueueWorker(root, local);
    await worker.initialize();
    await writeFile(join(root, 'jobs', 'other.json'), JSON.stringify(job()));
    await worker.runOnce();
    expect(JSON.parse(await readFile(join(root, 'results', 'other.json'), 'utf8')).status).toBe('rejected');
  });
});
