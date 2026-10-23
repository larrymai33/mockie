import type {
  InterviewContext,
  InterviewProvider,
  PolicyState,
  Session
} from "@mockie/core";
import {
  createFallbackScorecard,
  createPolicyState,
  decideNextAction
} from "@mockie/core";
import type { SessionRepository, StoredEvent, StoredEventInput } from "./repository.js";

export interface InterviewEngineOptions {
  repository: SessionRepository;
  provider?: InterviewProvider;
  providerForSession?: (session: Session) => InterviewProvider;
  onEvent?: (event: StoredEvent) => void;
  now?: () => number;
}

export class SessionEndingError extends Error {
  constructor() {
    super("Session is ending");
    this.name = "SessionEndingError";
  }
}
export class InterviewEngine {
  readonly #repository: SessionRepository;
  readonly #providerForSession: (session: Session) => InterviewProvider;
  readonly #onEvent: ((event: StoredEvent) => void) | undefined;
  readonly #now: () => number;
  readonly #states = new Map<string, PolicyState>();
  readonly #actions = new Map<string, Promise<StoredEvent[]>>();
  readonly #endings = new Map<string, Promise<Session>>();

  constructor(options: InterviewEngineOptions) {
    this.#repository = options.repository;
    if (!options.provider && !options.providerForSession) {
      throw new Error("InterviewEngine needs a provider or provider resolver");
    }
    this.#providerForSession = options.providerForSession ?? (() => options.provider!);
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? Date.now;
  }

  async acceptEvent(sessionId: string, input: StoredEventInput): Promise<StoredEvent[]> {
    if (this.#endings.has(sessionId)) throw new SessionEndingError();
    const session = this.#requiredActiveSession(sessionId);
    const state = this.#stateFor(session);
    const stored = this.#record(sessionId, input);
    const eventTime = Date.parse(input.createdAt);
    let policyEvent:
      | { type: "candidate_message"; text: string }
      | { type: "code_changed"; revision: number }
      | { type: "run_completed"; jobId: string }
      | null = null;
    if (input.type === "candidate_message") {
      policyEvent = { type: "candidate_message", text: String(input.payload.text ?? "") };
    } else if (input.type === "code_change") {
      policyEvent = { type: "code_changed", revision: Number(input.payload.revision ?? session.codeRevision) };
    } else if (input.type === "run_result") {
      policyEvent = { type: "run_completed", jobId: String(input.payload.jobId ?? "") };
    }
    if (!policyEvent) return [stored];
    const decision = decideNextAction(state, policyEvent, Number.isNaN(eventTime) ? this.#now() : eventTime);
    this.#states.set(sessionId, decision.state);
    const generated = await this.#act(sessionId, decision.action, decision.reason, input);
    return [stored, ...generated];
  }

  async tick(sessionId: string, now = this.#now()): Promise<StoredEvent[]> {
    const session = this.#repository.getSession(sessionId);
    if (!session || session.status !== "active" || this.#actions.has(sessionId) || this.#endings.has(sessionId)) return [];
    const decision = decideNextAction(this.#stateFor(session), { type: "tick" }, now);
    this.#states.set(sessionId, decision.state);
    return this.#act(sessionId, decision.action, decision.reason);
  }

  endSession(sessionId: string): Promise<Session> {
    const existing = this.#endings.get(sessionId);
    if (existing) return existing;
    const operation = this.#finishSession(sessionId).finally(() => {
      if (this.#endings.get(sessionId) === operation) this.#endings.delete(sessionId);
    });
    this.#endings.set(sessionId, operation);
    return operation;
  }

  async #finishSession(sessionId: string): Promise<Session> {
    for (;;) {
      const pending = this.#actions.get(sessionId);
      if (!pending) break;
      await pending;
    }
    const session = this.#requiredActiveSession(sessionId);
    this.#states.set(
      sessionId,
      decideNextAction(this.#stateFor(session), { type: "ended" }, this.#now()).state
    );
    const context = this.#context(sessionId, "session_end");
    let scorecard;
    try {
      scorecard = await this.#providerForSession(session).score(context);
    } catch {
      scorecard = createFallbackScorecard(context);
      this.#record(sessionId, {
        type: "system_status",
        role: "system",
        payload: {
          level: "error",
          recoverable: true,
          source: "provider",
          message: "The model was unavailable, so a local scorecard was saved."
        },
        createdAt: new Date(this.#now()).toISOString()
      });
    }
    this.#record(sessionId, {
      type: "session_ended",
      role: "system",
      payload: {},
      createdAt: new Date(this.#now()).toISOString()
    });
    return this.#repository.endSession(sessionId, scorecard, new Date(this.#now()).toISOString());
  }

  #requiredActiveSession(id: string): Session {
    const session = this.#repository.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (session.status !== "active") throw new Error(`Session has ended: ${id}`);
    return session;
  }

  #stateFor(session: Session): PolicyState {
    const existing = this.#states.get(session.id);
    if (existing) return existing;
    const state = createPolicyState(Date.parse(session.startedAt), session.durationMinutes * 60_000);
    const checkpoints = [0.5, 0.8, 0.95];
    const markObservation = (reason: unknown, at: number): void => {
      if (reason === "post_edit_pause") state.lastConsideredEditRevision = state.codeRevision;
      if (reason === "extended_idle") state.lastIdleConsideredAt = at;
      if (reason === "run_completed" && state.pendingRunId !== null) {
        if (!state.consideredRunIds.includes(state.pendingRunId)) state.consideredRunIds.push(state.pendingRunId);
        state.pendingRunId = null;
      }
      if (reason === "time_checkpoint") {
        const elapsed = at - state.startedAt;
        const checkpoint = checkpoints.find(
          (fraction) => elapsed >= fraction * state.durationMs && !state.consideredCheckpoints.includes(fraction)
        );
        if (checkpoint !== undefined) state.consideredCheckpoints.push(checkpoint);
      }
    };
    for (const event of this.#repository.listEvents(session.id)) {
      const at = Date.parse(event.createdAt);
      if (!Number.isFinite(at)) continue;
      if (event.type === "candidate_message") {
        state.lastActivityAt = Math.max(state.lastActivityAt, at);
        state.lastIdleConsideredAt = null;
      } else if (event.type === "code_change") {
        const revision = Number(event.payload.revision ?? 0);
        if (Number.isInteger(revision) && revision > state.codeRevision) {
          state.codeRevision = revision;
          state.lastMeaningfulEditAt = at;
          state.lastActivityAt = Math.max(state.lastActivityAt, at);
          state.lastIdleConsideredAt = null;
        }
      } else if (event.type === "run_result") {
        const jobId = String(event.payload.jobId ?? "");
        if (jobId && !state.consideredRunIds.includes(jobId)) state.pendingRunId = jobId;
        state.lastActivityAt = Math.max(state.lastActivityAt, at);
        state.lastIdleConsideredAt = null;
      } else if (event.type === "interviewer_message") {
        state.lastAutomaticSpeechAt = at;
        markObservation(event.payload.reason, at);
      } else if (event.type === "policy_observation" || event.type === "system_status") {
        markObservation(event.payload.reason, at);
      } else if (event.type === "session_ended") {
        state.status = "ended";
      }
    }
    state.codeRevision = Math.max(state.codeRevision, session.codeRevision);
    this.#states.set(session.id, state);
    return state;
  }

  async #act(
    sessionId: string,
    action: "respond" | "consider" | "silent",
    reason: string,
    source?: StoredEventInput
  ): Promise<StoredEvent[]> {
    if (action === "silent") return [];
    const pending = this.#actions.get(sessionId);
    if (pending && reason !== "direct_message") return [];
    const operation = (pending ?? Promise.resolve([])).then(() =>
      this.#performAction(sessionId, reason, source)
    );
    this.#actions.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#actions.get(sessionId) === operation) this.#actions.delete(sessionId);
    }
  }

  async #performAction(
    sessionId: string,
    reason: string,
    source?: StoredEventInput
  ): Promise<StoredEvent[]> {
    try {
      const candidateMessage =
        source?.type === "candidate_message" && typeof source.payload.text === "string"
          ? source.payload.text
          : undefined;
      const session = this.#requiredActiveSession(sessionId);
      const decision = await this.#providerForSession(session).respond(
        this.#context(sessionId, reason, candidateMessage)
      );
      if (decision.action !== "speak" || !decision.message.trim()) {
        return [
          this.#record(sessionId, {
            type: "policy_observation",
            role: "system",
            payload: { reason, outcome: "silent" },
            createdAt: new Date(this.#now()).toISOString()
          })
        ];
      }
      const message = this.#record(sessionId, {
        type: "interviewer_message",
        role: "interviewer",
        payload: { text: decision.message.trim(), reason },
        createdAt: new Date(this.#now()).toISOString()
      });
      const refreshedSession = this.#requiredActiveSession(sessionId);
      const next = decideNextAction(this.#stateFor(refreshedSession), { type: "automatic_speech" }, this.#now());
      this.#states.set(sessionId, next.state);
      return [message];
    } catch {
      return [
        this.#record(sessionId, {
          type: "system_status",
          role: "system",
          payload: {
            level: "error",
            recoverable: true,
            source: "provider",
            reason,
            message: "The interviewer could not reach the model. You can keep working while it reconnects."
          },
          createdAt: new Date(this.#now()).toISOString()
        })
      ];
    }
  }

  #context(sessionId: string, trigger: string, candidateMessage?: string): InterviewContext {
    const session = this.#repository.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {
      problem: session.problem,
      language: session.language,
      code: session.code,
      transcript: session.transcript,
      runs: session.runs,
      elapsedMs: Math.max(0, this.#now() - Date.parse(session.startedAt)),
      durationMs: session.durationMinutes * 60_000,
      trigger,
      ...(candidateMessage === undefined ? {} : { candidateMessage })
    };
  }

  #record(sessionId: string, input: StoredEventInput): StoredEvent {
    const event = this.#repository.appendEvent(sessionId, input);
    this.#onEvent?.(event);
    return event;
  }
}
