import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRepository } from "./repository.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mockie-db-"));
  directories.push(directory);
  return join(directory, "mockie.db");
}

const problem = {
  id: "custom-1",
  title: "Pair Sum",
  difficulty: "medium" as const,
  description: "Find the pair.",
  constraints: ["n >= 2"],
  examples: [],
  starterCode: { python: "def solve():\n    pass", javascript: "function solve() {}" }
};

describe("SessionRepository", () => {
  it("persists a session and its ordered timeline across repository restarts", () => {
    const path = databasePath();
    const first = new SessionRepository(path);
    const session = first.createSession({
      problem,
      language: "python",
      providerMode: "offline",
      durationMinutes: 45,
      now: "2026-10-22T20:00:00.000Z"
    });
    first.appendEvent(session.id, {
      type: "candidate_message",
      role: "candidate",
      payload: { text: "Can input be empty?", source: "typed" },
      createdAt: "2026-10-22T20:01:00.000Z"
    });
    first.appendEvent(session.id, {
      type: "code_change",
      role: "candidate",
      payload: { code: "def solve(): return []", revision: 1 },
      createdAt: "2026-10-22T20:02:00.000Z"
    });
    first.close();

    const reopened = new SessionRepository(path);
    expect(reopened.getSession(session.id)?.code).toBe("def solve(): return []");
    expect(reopened.listEvents(session.id).map((event) => event.type)).toEqual([
      "candidate_message",
      "code_change"
    ]);
    reopened.close();
  });

  it("merges settings and keeps them after restart", () => {
    const path = databasePath();
    const first = new SessionRepository(path);
    const updated = first.updateSettings({
      providerMode: "online",
      model: "chatgpt/gpt-5.4",
      defaultDurationMinutes: 60
    });
    expect(updated.defaultDurationMinutes).toBe(60);
    first.close();

    const reopened = new SessionRepository(path);
    expect(reopened.getSettings()).toMatchObject({ providerMode: "online", defaultDurationMinutes: 60 });
    reopened.close();
  });
});
