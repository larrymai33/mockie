import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RESULT_TIMEOUT_MS, QueueRunner, RunnerUnavailableError } from "./runner-client.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function queuePath(): string {
  const path = mkdtempSync(join(tmpdir(), "mockie-queue-"));
  directories.push(path);
  return path;
}

describe("QueueRunner", () => {
  it("leaves queue and publication margin above the maximum candidate wall limit", () => {
    expect(DEFAULT_RESULT_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it("publishes a job atomically and resolves its matching result", async () => {
    const queue = queuePath();
    const runner = new QueueRunner({ queuePath: queue, pollIntervalMs: 5, resultTimeoutMs: 500 });
    const pending = runner.run({ sessionId: "s1", language: "python", code: "print(42)" });

    let jobFile: string | undefined;
    for (let attempt = 0; attempt < 30 && !jobFile; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      jobFile = readdirSync(join(queue, "jobs")).find((name) => name.endsWith(".json"));
    }
    expect(jobFile).toBeTruthy();
    expect(readdirSync(join(queue, "jobs")).some((name) => name.endsWith(".tmp"))).toBe(false);
    const job = JSON.parse(readFileSync(join(queue, "jobs", jobFile!), "utf8")) as { id: string };
    mkdirSync(join(queue, "results"), { recursive: true });
    writeFileSync(
      join(queue, "results", `${job.id}.json`),
      JSON.stringify({
        jobId: job.id,
        sessionId: "s1",
        status: "success",
        stdout: "42\n",
        stderr: "",
        exitCode: 0,
        durationMs: 10,
        truncated: false,
        completedAt: new Date().toISOString()
      })
    );

    await expect(pending).resolves.toMatchObject({ status: "success", stdout: "42\n" });
  });

  it("fails with a recoverable timeout instead of waiting forever", async () => {
    const runner = new QueueRunner({ queuePath: queuePath(), pollIntervalMs: 5, resultTimeoutMs: 25 });

    await expect(runner.run({ sessionId: "s1", language: "javascript", code: "while(true){}" }))
      .rejects.toBeInstanceOf(RunnerUnavailableError);
  });
});
