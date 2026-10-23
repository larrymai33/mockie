import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterviewProvider } from "@mockie/core";
import { InterviewEngine, SessionEndingError } from "./engine.js";
import { SessionRepository } from "./repository.js";

const directories: string[] = [];
const repositories: SessionRepository[] = [];
afterEach(() => {
  repositories.splice(0).forEach((repository) => repository.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function setup(provider: InterviewProvider) {
  const directory = mkdtempSync(join(tmpdir(), "mockie-engine-"));
  directories.push(directory);
  const repository = new SessionRepository(join(directory, "db.sqlite"));
  repositories.push(repository);
  const session = repository.createSession({
    problem: {
      id: "p",
      title: "Pair Sum",
      difficulty: "easy",
      description: "Find a pair.",
      constraints: [],
      examples: [],
      starterCode: { python: "def solve(): pass", javascript: "function solve() {}" }
    },
    language: "python",
    providerMode: provider.mode,
    durationMinutes: 45,
    now: "2026-10-22T20:00:00.000Z"
  });
  return { repository, session, engine: new InterviewEngine({ repository, provider }) };
}

describe("InterviewEngine", () => {
  it("answers a direct candidate question and records the interviewer event", async () => {
    const provider: InterviewProvider = {
      mode: "offline",
      respond: vi.fn().mockResolvedValue({ action: "speak", message: "What would empty input imply?" }),
      score: vi.fn()
    };
    const { engine, repository, session } = setup(provider);

    await engine.acceptEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "Can the input be empty?", source: "typed" },
      createdAt: "2026-10-22T20:01:00.000Z"
    });

    expect(repository.listEvents(session.id).at(-1)).toMatchObject({
      type: "interviewer_message",
      role: "interviewer",
      payload: { text: "What would empty input imply?" }
    });
  });

  it("keeps the session active and records status when the provider fails", async () => {
    const provider: InterviewProvider = {
      mode: "online",
      respond: vi.fn().mockRejectedValue(new Error("upstream unavailable")),
      score: vi.fn()
    };
    const { engine, repository, session } = setup(provider);

    await expect(
      engine.acceptEvent(session.id, {
        type: "candidate_message",
        role: "candidate",
        payload: { text: "What are the constraints?", source: "typed" },
        createdAt: "2026-10-22T20:01:00.000Z"
      })
    ).resolves.toBeDefined();

    expect(repository.getSession(session.id)?.status).toBe("active");
    expect(repository.listEvents(session.id).at(-1)).toMatchObject({
      type: "system_status",
      payload: { level: "error", recoverable: true }
    });
  });

  it("queues concurrent direct questions so each receives a provider response", async () => {
    let releaseFirst!: (value: { action: "speak"; message: string }) => void;
    const firstResponse = new Promise<{ action: "speak"; message: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const respond = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({ action: "speak", message: "Second reply" });
    const provider: InterviewProvider = { mode: "online", respond, score: vi.fn() };
    const { engine, repository, session } = setup(provider);

    const first = engine.acceptEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "First question?", source: "typed" },
      createdAt: "2026-10-22T20:01:00.000Z"
    });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const second = engine.acceptEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "Second question?", source: "typed" },
      createdAt: "2026-10-22T20:01:01.000Z"
    });

    await Promise.resolve();
    expect(respond).toHaveBeenCalledTimes(1);
    releaseFirst({ action: "speak", message: "First reply" });
    await Promise.all([first, second]);

    expect(respond).toHaveBeenCalledTimes(2);
    expect(repository.listEvents(session.id).filter((event) => event.type === "interviewer_message")).toHaveLength(2);
  });

  it("waits for an in-flight reply before scoring and ending the session", async () => {
    let releaseReply!: (value: { action: "speak"; message: string }) => void;
    const response = new Promise<{ action: "speak"; message: string }>((resolve) => {
      releaseReply = resolve;
    });
    const score = vi.fn().mockImplementation(async (context) => ({
      summary: `Scored ${context.transcript.length} transcript entries.`,
      categories: [
        { key: "communication", score: 3, feedback: "Clear." },
        { key: "problem_solving", score: 3, feedback: "Steady." },
        { key: "coding", score: 3, feedback: "Readable." },
        { key: "testing", score: 3, feedback: "Some tests." },
        { key: "complexity", score: 3, feedback: "Discussed." }
      ],
      strengths: [],
      improvements: [],
      source: "model"
    }));
    const provider: InterviewProvider = {
      mode: "online",
      respond: vi.fn().mockImplementation(() => response),
      score
    };
    const { engine, repository, session } = setup(provider);

    const message = engine.acceptEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "One last question?", source: "typed" },
      createdAt: "2026-10-22T20:01:00.000Z"
    });
    await vi.waitFor(() => expect(provider.respond).toHaveBeenCalledOnce());
    const ending = engine.endSession(session.id);
    await Promise.resolve();
    expect(score).not.toHaveBeenCalled();

    releaseReply({ action: "speak", message: "One last reply" });
    await Promise.all([message, ending]);

    expect(score).toHaveBeenCalledOnce();
    expect(score.mock.calls[0]?.[0].transcript).toHaveLength(2);
    const types = repository.listEvents(session.id).map((event) => event.type);
    expect(types.indexOf("interviewer_message")).toBeLessThan(types.indexOf("session_ended"));
  });

  it("restores a pending post-edit pause after the server restarts", async () => {
    const respond = vi.fn().mockResolvedValue({ action: "silent", message: "" });
    const provider: InterviewProvider = { mode: "online", respond, score: vi.fn() };
    const { repository, session } = setup(provider);
    const started = Date.parse(session.startedAt);
    const firstEngine = new InterviewEngine({ repository, provider, now: () => started + 10_000 });

    await firstEngine.acceptEvent(session.id, {
      type: "code_change",
      role: "candidate",
      payload: { code: "def solve():\n    return 1", revision: 1 },
      createdAt: new Date(started + 10_000).toISOString()
    });
    const restarted = new InterviewEngine({ repository, provider, now: () => started + 18_000 });
    await restarted.tick(session.id, started + 18_000);

    expect(respond).toHaveBeenCalledOnce();
  });

  it("does not repeat a silent time-checkpoint consideration after restart", async () => {
    const respond = vi.fn().mockResolvedValue({ action: "silent", message: "" });
    const provider: InterviewProvider = { mode: "online", respond, score: vi.fn() };
    const { repository, session } = setup(provider);
    const started = Date.parse(session.startedAt);
    const halfTime = started + session.durationMinutes * 60_000 * 0.5;
    repository.appendEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "I am still working.", source: "typed" },
      createdAt: new Date(halfTime - 10_000).toISOString()
    });
    const firstEngine = new InterviewEngine({ repository, provider, now: () => halfTime });

    await firstEngine.tick(session.id, halfTime);
    expect(respond).toHaveBeenCalledOnce();
    const restarted = new InterviewEngine({ repository, provider, now: () => halfTime + 1_000 });
    await restarted.tick(session.id, halfTime + 1_000);

    expect(respond).toHaveBeenCalledOnce();
  });

  it("rejects new candidate events while scoring and deduplicates concurrent end requests", async () => {
    let releaseScore!: (value: Awaited<ReturnType<InterviewProvider["score"]>>) => void;
    const pendingScore = new Promise<Awaited<ReturnType<InterviewProvider["score"]>>>((resolve) => {
      releaseScore = resolve;
    });
    const score = vi.fn().mockImplementation(() => pendingScore);
    const provider: InterviewProvider = {
      mode: "online",
      respond: vi.fn(),
      score
    };
    const { engine, repository, session } = setup(provider);

    const firstEnd = engine.endSession(session.id);
    const secondEnd = engine.endSession(session.id);
    await vi.waitFor(() => expect(score).toHaveBeenCalledOnce());
    await expect(
      engine.acceptEvent(session.id, {
        type: "candidate_message",
        role: "candidate",
        payload: { text: "Spoken after End", source: "voice" },
        createdAt: "2026-10-22T20:02:00.000Z"
      })
    ).rejects.toBeInstanceOf(SessionEndingError);

    releaseScore({
      summary: "Complete.",
      categories: [
        { key: "communication", score: 3, feedback: "Clear." },
        { key: "problem_solving", score: 3, feedback: "Steady." },
        { key: "coding", score: 3, feedback: "Readable." },
        { key: "testing", score: 3, feedback: "Some tests." },
        { key: "complexity", score: 3, feedback: "Discussed." }
      ],
      strengths: [],
      improvements: [],
      source: "model"
    });
    const [endedFirst, endedSecond] = await Promise.all([firstEnd, secondEnd]);

    expect(endedFirst.id).toBe(endedSecond.id);
    expect(score).toHaveBeenCalledOnce();
    expect(repository.getSession(session.id)?.transcript).toEqual([]);
  });

  it("restores a run follow-up that was deferred by the post-edit quiet window", async () => {
    const respond = vi.fn().mockResolvedValue({ action: "silent", message: "" });
    const provider: InterviewProvider = { mode: "online", respond, score: vi.fn() };
    const { repository, session } = setup(provider);
    const started = Date.parse(session.startedAt);
    const firstEngine = new InterviewEngine({ repository, provider, now: () => started + 11_000 });
    await firstEngine.acceptEvent(session.id, {
      type: "code_change",
      role: "candidate",
      payload: { code: "def solve():\n    return 1", revision: 1 },
      createdAt: new Date(started + 10_000).toISOString()
    });
    await firstEngine.acceptEvent(session.id, {
      type: "run_result",
      role: "system",
      payload: { jobId: "deferred-run", status: "success", stdout: "1\n", stderr: "" },
      createdAt: new Date(started + 11_000).toISOString()
    });
    expect(respond).not.toHaveBeenCalled();

    const restarted = new InterviewEngine({ repository, provider, now: () => started + 18_000 });
    await restarted.tick(session.id, started + 18_000);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0].trigger).toBe("run_completed");
  });
});
