import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterviewProvider, RunResult } from "@mockie/core";
import { buildApp } from "./app.js";
import { SessionRepository } from "./repository.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mockie-api-"));
  directories.push(directory);
  const repository = new SessionRepository(join(directory, "db.sqlite"));
  const provider: InterviewProvider = {
    mode: "offline",
    respond: vi.fn().mockResolvedValue({ action: "speak", message: "What should happen for an empty list?" }),
    score: vi.fn().mockResolvedValue({
      summary: "A thoughtful start.",
      categories: [
        { key: "communication", score: 4, feedback: "Clear." },
        { key: "problem_solving", score: 3, feedback: "Solid decomposition." },
        { key: "coding", score: 3, feedback: "Readable." },
        { key: "testing", score: 2, feedback: "Add edge cases." },
        { key: "complexity", score: 3, feedback: "Discuss trade-offs." }
      ],
      strengths: ["Explained assumptions"],
      improvements: ["Test empty input"],
      source: "offline"
    })
  };
  const runResult: RunResult = {
    jobId: "job-1",
    sessionId: "placeholder",
    status: "success",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    durationMs: 12,
    truncated: false,
    completedAt: "2026-10-22T20:05:00.000Z"
  };
  const runner = { run: vi.fn().mockImplementation(({ sessionId }) => Promise.resolve({ ...runResult, sessionId })) };
  const app = buildApp({ repository, provider, runner, startScheduler: false });
  return { app, repository, runner };
}

describe("Mockie API", () => {
  it("accepts a WebSocket connection for an existing session", async () => {
    const { app } = setup();
    const problem = (await app.inject({ method: "GET", url: "/api/problems" })).json().problems[0];
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { problemId: problem.id, language: "python", durationMinutes: 45, mode: "offline" }
      })
    ).json().session;

    const socket = await app.injectWS(`/ws?sessionId=${session.id}`);
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
    await app.close();
  });

  it("conducts and persists the offline interview lifecycle", async () => {
    const { app, repository } = setup();
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const problems = (await app.inject({ method: "GET", url: "/api/problems" })).json();
    expect(problems.problems.length).toBeGreaterThan(0);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { problemId: problems.problems[0].id, language: "python", durationMinutes: 45, mode: "offline" }
    });
    expect(createdResponse.statusCode).toBe(201);
    const session = createdResponse.json().session;

    const message = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/events`,
      payload: { type: "candidate_message", text: "Can input be empty?", source: "typed" }
    });
    expect(message.statusCode).toBe(202);
    expect(repository.getSession(session.id)?.transcript).toHaveLength(2);

    const run = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/run`,
      payload: { language: "python", code: "print('ok')" }
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.stdout).toBe("ok\n");

    const ended = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/end` });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().scorecard.categories).toHaveLength(5);

    const history = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(history.sessions[0]).toMatchObject({ id: session.id, status: "ended" });
    await app.close();
  });

  it("returns a recoverable runner error and leaves the session active", async () => {
    const { app, runner, repository } = setup();
    runner.run.mockRejectedValueOnce(new Error("runner offline"));
    const problem = (await app.inject({ method: "GET", url: "/api/problems" })).json().problems[0];
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { problemId: problem.id, language: "javascript", durationMinutes: 45, mode: "offline" }
      })
    ).json().session;

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/run`,
      payload: { language: "javascript", code: "console.log(1)" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ recoverable: true, source: "runner" });
    expect(repository.getSession(session.id)?.status).toBe("active");
    await app.close();
  });

  it("never returns the provider key and preserves it during unrelated settings updates", async () => {
    const { app, repository } = setup();
    repository.updateSettings({ apiKey: "sk-private-proxy-key" });

    const before = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(before).not.toHaveProperty("apiKey");
    const updated = (
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { model: "chatgpt/another-model" }
      })
    ).json();

    expect(updated).not.toHaveProperty("apiKey");
    expect(repository.getSettings()).toMatchObject({
      apiKey: "sk-private-proxy-key",
      model: "chatgpt/another-model"
    });
    await app.close();
  });
});
