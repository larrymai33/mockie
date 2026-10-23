import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, readFileSync, readdirSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const jobSchema = z.object({
  id: z.string().regex(safeId), sessionId: z.string().regex(safeId),
  language: z.enum(['python', 'javascript']), code: z.string().max(65_536),
  stdin: z.string().max(65_536).optional(), createdAt: z.string().datetime(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
export type RunJob = z.infer<typeof jobSchema>;
export interface RunResult {
  jobId: string; sessionId: string; status: 'success' | 'error' | 'timeout' | 'rejected';
  stdout: string; stderr: string; exitCode: number | null; durationMs: number;
  truncated: boolean; completedAt: string;
}
export interface Command { executable: string; args: string[] }
export interface ExecutionOptions {
  timeoutMs?: number;
  outputLimitBytes?: number;
  childUid?: number | undefined;
  childGid?: number | undefined;
  commandBuilder?: (language: RunJob['language'], sourceFile: string) => Command;
}
export function parseJob(input: unknown): RunJob { return jobSchema.parse(input); }

export function buildCommand(language: RunJob['language'], sourceFile: string, identity = { uid: 65534, gid: 65534 }): Command {
  if (language !== 'python' && language !== 'javascript') throw new Error('Unsupported language');
  if (![identity.uid, identity.gid].every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647)) throw new Error('Child identity must be unprivileged');
  const interpreter = language === 'python'
    ? ['/usr/bin/python3', '-I', '-B', sourceFile]
    : ['/usr/local/bin/node', '--max-old-space-size=64', '--jitless', sourceFile];
  return { executable: '/usr/bin/setpriv', args: [
    `--reuid=${identity.uid}`, `--regid=${identity.gid}`, '--clear-groups', '--inh-caps=-all',
    '--ambient-caps=-all', '--no-new-privs', '--', '/usr/bin/prlimit',
    '--cpu=3:3', '--as=2147483648:2147483648', '--fsize=1048576:1048576',
    '--nproc=32:32', '--nofile=64:64', '--core=0:0', '--', ...interpreter,
  ] };
}

function failure(input: unknown, message: string, status: RunResult['status'] = 'error', id?: string): RunResult {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    jobId: id ?? (typeof fields.id === 'string' && safeId.test(fields.id) ? fields.id : 'invalid'),
    sessionId: typeof fields.sessionId === 'string' && safeId.test(fields.sessionId) ? fields.sessionId : 'invalid',
    status, stdout: '', stderr: message, exitCode: null, durationMs: 0, truncated: false,
    completedAt: new Date().toISOString(),
  };
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private limit: number) {}
  append(chunk: Buffer) {
    const remaining = this.limit - this.bytes;
    if (chunk.length > remaining) this.truncated = true;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.bytes += kept.length;
  }
  text() {
    // write() keeps an incomplete trailing UTF-8 character buffered; do not flush it.
    return new StringDecoder('utf8').write(Buffer.concat(this.chunks));
  }
}

function candidateProcesses(uid: number): number[] {
  if (process.platform !== 'linux') return [];
  const processes: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const owner = /^Uid:\s+(\d+)/m.exec(status);
      const state = /^State:\s+(\w)/m.exec(status);
      if (Number(owner?.[1]) === uid && state?.[1] !== 'Z') processes.push(pid);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return processes;
}

/**
 * The worker is single-tenant and reserves childUid exclusively for candidate
 * programs. Killing by UID closes the setsid/double-fork escape that a process
 * group alone cannot contain. Compose's PID namespace keeps this scoped to the
 * runner container.
 */
function killCandidateProcesses(uid: number): boolean {
  if (process.platform !== 'linux') return true;
  const deadline = Date.now() + 500;
  let succeeded = true;
  do {
    const pids = candidateProcesses(uid);
    if (pids.length === 0) return succeeded;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') succeeded = false;
      }
    }
    // Let SIGKILL complete before checking for descendants forked during cleanup.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  } while (Date.now() < deadline);
  return candidateProcesses(uid).length === 0 && succeeded;
}

export async function executeJob(input: unknown, options: ExecutionOptions = {}): Promise<RunResult> {
  let job: RunJob;
  try { job = parseJob(input); } catch { return failure(input, 'Invalid job: expected Python or JavaScript, safe identifiers and bounded code/stdin.', 'rejected'); }
  const started = Date.now();
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'mockie-exec-'));
    await chmod(directory, 0o755);
    const work = join(directory, 'work');
    await mkdir(work, { mode: 0o777 });
    await chmod(work, 0o777);
    const sourceFile = join(directory, job.language === 'python' ? 'main.py' : 'main.cjs');
    await writeFile(sourceFile, job.code, { mode: 0o444 });
    const command = options.commandBuilder
      ? options.commandBuilder(job.language, sourceFile)
      : buildCommand(job.language, sourceFile, { uid: options.childUid ?? 65534, gid: options.childGid ?? 65534 });
    const cleanupUid = options.childUid ?? (options.commandBuilder ? null : 65534);
    if (cleanupUid !== null && !killCandidateProcesses(cleanupUid)) throw new Error('Unable to clear candidate processes before execution');
    const timeoutMs = Math.min(job.timeoutMs ?? Infinity, options.timeoutMs ?? 5000);
    const outputLimit = options.outputLimitBytes ?? 65_536;
    const stdout = new BoundedOutput(outputLimit);
    const stderr = new BoundedOutput(outputLimit);
    const outcome = await new Promise<{ exitCode: number | null; timeout: boolean; error?: string }>((resolve) => {
      let timedOut = false;
      let startupError: string | undefined;
      const child = spawn(command.executable, command.args, {
        cwd: work, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        // setpriv drops identity/groups before prlimit. Node's uid/gid options
        // alone do not provide an explicit supplementary-group/capability policy.
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: work, TMPDIR: work, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      });
      const killGroup = () => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') startupError = 'Unable to terminate candidate process';
        }
      };
      const terminate = () => {
        killGroup();
        if (cleanupUid !== null && !killCandidateProcesses(cleanupUid)) startupError = 'Unable to terminate every candidate process';
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
      child.stdin.on('error', () => { /* Early exit may close stdin before it is consumed. */ });
      child.stdin.end(job.stdin ?? '');
      child.once('error', (error) => { startupError = error.message; });
      child.once('exit', terminate); // Reap descendants, including those that created a new process session.
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode: startupError ? null : exitCode, timeout: timedOut, ...(startupError ? { error: startupError } : {}) });
      });
    });
    return {
      jobId: job.id, sessionId: job.sessionId,
      status: outcome.timeout ? 'timeout' : outcome.error || outcome.exitCode !== 0 ? 'error' : 'success',
      stdout: stdout.text(), stderr: outcome.error ?? stderr.text(), exitCode: outcome.exitCode,
      durationMs: Date.now() - started, truncated: stdout.truncated || stderr.truncated,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ...failure(job, `Runner error: ${(error as Error).message}`), durationMs: Date.now() - started };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

const MAX_JOB_BYTES = 1_048_576; // Escaped JSON may be larger than the bounded decoded strings.
export class QueueWorker {
  private busy = false;
  constructor(readonly root: string, private options: ExecutionOptions = {}) {}

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o770 });
    await chmod(this.root, 0o770);
    for (const folder of ['jobs', 'processing', 'results']) {
      await mkdir(join(this.root, folder), { recursive: true, mode: 0o770 });
      await chmod(join(this.root, folder), 0o770);
    }
    // This service is a single replica. Every processing entry belongs to its previous lifetime.
    for (const name of (await readdir(join(this.root, 'processing'))).sort()) {
      if (!this.validName(name)) continue;
      const id = name.slice(0, -5);
      let input: unknown;
      try { input = await this.readJob(join(this.root, 'processing', name)); } catch { input = {}; }
      await this.publish(id, failure(input, 'Execution interrupted by runner restart; run again.'));
      await unlink(join(this.root, 'processing', name));
    }
    await this.heartbeat();
  }

  private validName(name: string) { return name.endsWith('.json') && safeId.test(name.slice(0, -5)); }

  private async readJob(path: string): Promise<unknown> {
    const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_JOB_BYTES) throw new Error('Invalid job file');
      const buffer = Buffer.alloc(MAX_JOB_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_JOB_BYTES) throw new Error('Job too large');
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
    } finally { await handle.close(); }
  }

  private async publish(id: string, result: RunResult) {
    const directory = join(this.root, 'results');
    const target = join(directory, `${id}.json`);
    const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o640);
    try { await handle.chmod(0o640); await handle.writeFile(JSON.stringify({ ...result, jobId: id })); await handle.sync(); }
    finally { await handle.close(); }
    try {
      // A hard link publishes atomically without overwriting a previously completed result.
      await link(temporary, target);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
  }

  async heartbeat() {
    const temporary = join(this.root, `.heartbeat.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), pid: process.pid }), { mode: 0o640 });
    await chmod(temporary, 0o640);
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, join(this.root, 'heartbeat.json')); break; }
        catch (error) {
          // Windows can briefly deny replacement while a healthcheck has the
          // destination open. Keep the old complete record until rename succeeds.
          if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 5) throw error;
          await delay(10 * (attempt + 1));
        }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.heartbeat();
      const name = (await readdir(join(this.root, 'jobs'))).sort().find((entry) => this.validName(entry));
      if (!name) return false;
      const id = name.slice(0, -5);
      const processing = join(this.root, 'processing', name);
      try { await rename(join(this.root, 'jobs', name), processing); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      try {
        await stat(join(this.root, 'results', name));
        await unlink(processing);
        return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let result: RunResult;
      let input: unknown;
      try {
        input = await this.readJob(processing);
        const parsed = parseJob(input);
        if (parsed.id !== id) throw new Error('Queue filename does not match job ID');
        result = await executeJob(parsed, this.options);
      } catch { result = failure(input, 'Invalid queued job', 'rejected', id); }
      await this.publish(id, result);
      await unlink(processing);
      await this.heartbeat();
      return true;
    } finally { this.busy = false; }
  }
}
