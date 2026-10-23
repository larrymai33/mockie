import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Language, RunJob, RunResult } from "@mockie/core";

const runResultSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(["success", "error", "timeout", "rejected"]),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
  completedAt: z.string().datetime()
});

export const DEFAULT_RESULT_TIMEOUT_MS = 25_000;

export class RunnerUnavailableError extends Error {
  constructor(message = "The code runner did not return a result in time") {
    super(message);
    this.name = "RunnerUnavailableError";
  }
}
export interface QueueRunnerOptions {
  queuePath: string;
  pollIntervalMs?: number;
  resultTimeoutMs?: number;
}

export interface RunRequest {
  sessionId: string;
  language: Language;
  code: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface CodeRunner {
  run(request: RunRequest): Promise<RunResult>;
}

export class QueueRunner implements CodeRunner {
  readonly #queuePath: string;
  readonly #pollIntervalMs: number;
  readonly #resultTimeoutMs: number;

  constructor(options: QueueRunnerOptions) {
    this.#queuePath = options.queuePath;
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
    this.#resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
  }

  async run(request: RunRequest): Promise<RunResult> {
    const id = randomUUID();
    const jobsPath = join(this.#queuePath, "jobs");
    const resultsPath = join(this.#queuePath, "results");
    await Promise.all([mkdir(jobsPath, { recursive: true }), mkdir(resultsPath, { recursive: true })]);
    const job: RunJob = {
      id,
      sessionId: request.sessionId,
      language: request.language,
      code: request.code,
      createdAt: new Date().toISOString(),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
    };
    const temporaryPath = join(jobsPath, `${id}.${randomUUID()}.tmp`);
    const jobPath = join(jobsPath, `${id}.json`);
    const resultPath = join(resultsPath, `${id}.json`);
    await writeFile(temporaryPath, JSON.stringify(job), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, jobPath);

    const deadline = Date.now() + this.#resultTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
        const result = runResultSchema.parse(value) as RunResult;
        if (result.jobId !== id || result.sessionId !== request.sessionId) {
          throw new RunnerUnavailableError("The code runner returned a mismatched result");
        }
        await rm(resultPath, { force: true });
        return result;
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof RunnerUnavailableError) {
          await rm(resultPath, { force: true });
          if (error instanceof RunnerUnavailableError) throw error;
          throw new RunnerUnavailableError("The code runner returned an invalid result");
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
    await Promise.all([rm(jobPath, { force: true }), rm(temporaryPath, { force: true })]);
    throw new RunnerUnavailableError();
  }
}
