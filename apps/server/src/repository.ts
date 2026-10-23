import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  AppSettings,
  Language,
  Problem,
  ProviderMode,
  RunResult,
  Scorecard,
  Session,
  TranscriptEntry
} from "@mockie/core";

export type StoredEventType =
  | "candidate_message"
  | "code_change"
  | "interviewer_message"
  | "run_result"
  | "policy_observation"
  | "system_status"
  | "session_started"
  | "session_ended";

export interface StoredEventInput {
  type: StoredEventType;
  role: "candidate" | "interviewer" | "system";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StoredEvent extends StoredEventInput {
  id: string;
  sessionId: string;
}

export interface CreateSessionInput {
  problem: Problem;
  language: Language;
  providerMode: ProviderMode;
  durationMinutes: number;
  now?: string;
}

export interface ServerSettings extends AppSettings {
  defaultDurationMinutes: number;
}

type SessionRow = {
  id: string;
  problem_json: string;
  language: Language;
  duration_minutes: number;
  provider_mode: ProviderMode;
  status: "active" | "ended";
  code: string;
  code_revision: number;
  started_at: string;
  ended_at: string | null;
  scorecard_json: string | null;
};

const DEFAULT_SETTINGS: ServerSettings = {
  providerMode: "offline",
  baseUrl: "http://litellm:4000",
  model: "chatgpt/gpt-5.4",
  apiKey: "",
  defaultDurationMinutes: 45,
  autoSpeak: true,
  autoListen: true
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class SessionRepository {
  readonly #database: Database.Database;
  readonly #defaultSettings: ServerSettings;

  constructor(path: string, defaults: Partial<ServerSettings> = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path);
    this.#defaultSettings = { ...DEFAULT_SETTINGS, ...defaults };
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        problem_json TEXT NOT NULL,
        language TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        provider_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        code TEXT NOT NULL,
        code_revision INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        scorecard_json TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_sequence
        ON events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value_json TEXT NOT NULL
      );
    `);
  }

  createSession(input: CreateSessionInput): Session {
    const id = randomUUID();
    const startedAt = input.now ?? new Date().toISOString();
    const code = input.problem.starterCode[input.language];
    this.#database.prepare(`
      INSERT INTO sessions (
        id, problem_json, language, duration_minutes, provider_mode,
        status, code, code_revision, started_at, ended_at, scorecard_json
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, NULL, NULL)
    `).run(
      id,
      JSON.stringify(input.problem),
      input.language,
      input.durationMinutes,
      input.providerMode,
      code,
      startedAt
    );
    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    const row = this.#database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? this.#hydrateSession(row) : null;
  }

  listSessions(): Session[] {
    const rows = this.#database.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all() as SessionRow[];
    return rows.map((row) => this.#hydrateSession(row));
  }

  listActiveSessions(): Session[] {
    const rows = this.#database
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at")
      .all() as SessionRow[];
    return rows.map((row) => this.#hydrateSession(row));
  }

  appendEvent(sessionId: string, input: StoredEventInput): StoredEvent {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    const event: StoredEvent = { ...input, id: randomUUID(), sessionId };
    const transaction = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO events (id, session_id, type, role, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.id, sessionId, input.type, input.role, JSON.stringify(input.payload), input.createdAt);
      if (input.type === "code_change") {
        const code = typeof input.payload.code === "string" ? input.payload.code : null;
        const revision = typeof input.payload.revision === "number" ? input.payload.revision : null;
        if (code !== null && revision !== null) {
          this.#database
            .prepare("UPDATE sessions SET code = ?, code_revision = MAX(code_revision, ?) WHERE id = ?")
            .run(code, revision, sessionId);
        }
      }
    });
    transaction();
    return event;
  }

  listEvents(sessionId: string): StoredEvent[] {
    const rows = this.#database.prepare(`
      SELECT id, session_id, type, role, payload_json, created_at
      FROM events WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as Array<{
      id: string;
      session_id: string;
      type: StoredEventType;
      role: StoredEvent["role"];
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      role: row.role,
      payload: parseJson<Record<string, unknown>>(row.payload_json),
      createdAt: row.created_at
    }));
  }

  saveRun(result: RunResult): void {
    this.#database.prepare(`
      INSERT INTO runs (job_id, session_id, result_json) VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET result_json = excluded.result_json
    `).run(result.jobId, result.sessionId, JSON.stringify(result));
  }

  endSession(id: string, scorecard: Scorecard, endedAt = new Date().toISOString()): Session {
    const result = this.#database
      .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, scorecard_json = ? WHERE id = ?")
      .run(endedAt, JSON.stringify(scorecard), id);
    if (result.changes === 0) throw new Error(`Session not found: ${id}`);
    return this.getSession(id)!;
  }

  getSettings(): ServerSettings {
    const row = this.#database.prepare("SELECT value_json FROM settings WHERE id = 1").get() as
      | { value_json: string }
      | undefined;
    return row ? { ...this.#defaultSettings, ...parseJson<Partial<ServerSettings>>(row.value_json) } : { ...this.#defaultSettings };
  }

  updateSettings(update: Partial<ServerSettings>): ServerSettings {
    const settings = { ...this.getSettings(), ...update };
    this.#database.prepare(`
      INSERT INTO settings (id, value_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json
    `).run(JSON.stringify(settings));
    return settings;
  }

  close(): void {
    this.#database.close();
  }

  #hydrateSession(row: SessionRow): Session {
    const transcript = this.listEvents(row.id)
      .filter((event) => event.type === "candidate_message" || event.type === "interviewer_message")
      .map<TranscriptEntry>((event) => ({
        id: event.id,
        role: event.role === "interviewer" ? "interviewer" : "candidate",
        text: typeof event.payload.text === "string" ? event.payload.text : "",
        createdAt: event.createdAt
      }));
    const runs = this.#database
      .prepare("SELECT result_json FROM runs WHERE session_id = ? ORDER BY sequence")
      .all(row.id) as Array<{ result_json: string }>;
    return {
      id: row.id,
      problem: parseJson<Problem>(row.problem_json),
      language: row.language,
      durationMinutes: row.duration_minutes,
      providerMode: row.provider_mode,
      status: row.status,
      code: row.code,
      codeRevision: row.code_revision,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      transcript,
      runs: runs.map((run) => parseJson<RunResult>(run.result_json)),
      scorecard: row.scorecard_json ? parseJson<Scorecard>(row.scorecard_json) : null
    };
  }
}
