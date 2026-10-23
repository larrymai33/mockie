/** Policy clock values are epoch milliseconds, supplied by the server. */
export interface PolicyState {
  status: 'active' | 'ended';
  startedAt: number;
  durationMs: number;
  lastActivityAt: number;
  lastMeaningfulEditAt: number | null;
  lastAutomaticSpeechAt: number | null;
  codeRevision: number;
  lastConsideredEditRevision: number;
  consideredRunIds: string[];
  pendingRunId: string | null;
  lastIdleConsideredAt: number | null;
  consideredCheckpoints: number[];
}

export type PolicyEvent =
  | { type: 'candidate_message'; text: string }
  | { type: 'code_changed'; revision: number }
  | { type: 'run_completed'; jobId: string }
  | { type: 'automatic_speech' }
  | { type: 'tick' }
  | { type: 'ended' };

export type ActionReason = 'direct_message' | 'post_edit_pause' | 'extended_idle' | 'run_completed' | 'time_checkpoint' | 'quiet' | 'cooldown' | 'terminal';

export interface PolicyDecision {
  action: 'respond' | 'consider' | 'silent';
  reason: ActionReason;
  state: PolicyState;
}

export function createPolicyState(startedAt: number, durationMs: number): PolicyState {
  return {
    status: 'active', startedAt, durationMs, lastActivityAt: startedAt,
    lastMeaningfulEditAt: null, lastAutomaticSpeechAt: null, codeRevision: 0,
    lastConsideredEditRevision: 0, consideredRunIds: [], pendingRunId: null,
    lastIdleConsideredAt: null, consideredCheckpoints: [],
  };
}

/** Pure reducer: persist the returned state even when the provider chooses silence. */
export function decideNextAction(previous: PolicyState, event: PolicyEvent, now: number): PolicyDecision {
  const state = { ...previous };
  const result = (action: PolicyDecision['action'], reason: ActionReason): PolicyDecision => ({ action, reason, state });
  if (state.status === 'ended' || event.type === 'ended') {
    state.status = 'ended';
    return result('silent', 'terminal');
  }
  if (event.type === 'candidate_message') {
    if (!event.text.trim()) return result('silent', 'quiet');
    state.lastActivityAt = now;
    state.lastIdleConsideredAt = null;
    return result('respond', 'direct_message');
  }
  if (event.type === 'code_changed') {
    if (Number.isInteger(event.revision) && event.revision > state.codeRevision) {
      state.codeRevision = event.revision;
      state.lastMeaningfulEditAt = now;
      state.lastActivityAt = now;
      state.lastIdleConsideredAt = null;
    }
    return result('silent', 'quiet');
  }
  if (event.type === 'automatic_speech') {
    state.lastAutomaticSpeechAt = now;
    return result('silent', 'quiet');
  }
  if (event.type === 'run_completed') {
    if (state.consideredRunIds.includes(event.jobId)) return result('silent', 'quiet');
    state.pendingRunId = event.jobId;
    state.lastActivityAt = now;
    state.lastIdleConsideredAt = null;
  }

  // An automatic observation must never break the quiet window after typing.
  if (state.lastMeaningfulEditAt !== null && now - state.lastMeaningfulEditAt < 7_000) return result('silent', 'quiet');
  if (state.lastAutomaticSpeechAt !== null && now - state.lastAutomaticSpeechAt < 60_000) return result('silent', 'cooldown');
  if (state.pendingRunId !== null) {
    state.consideredRunIds = [...state.consideredRunIds, state.pendingRunId];
    state.pendingRunId = null;
    return result('consider', 'run_completed');
  }
  if (state.lastMeaningfulEditAt !== null && state.codeRevision > state.lastConsideredEditRevision && now - state.lastMeaningfulEditAt >= 7_000) {
    state.lastConsideredEditRevision = state.codeRevision;
    return result('consider', 'post_edit_pause');
  }
  const elapsed = now - state.startedAt;
  const checkpoint = [0.5, 0.8, 0.95].find(fraction => elapsed >= fraction * state.durationMs && !state.consideredCheckpoints.includes(fraction));
  if (checkpoint !== undefined) {
    state.consideredCheckpoints = [...state.consideredCheckpoints, checkpoint];
    return result('consider', 'time_checkpoint');
  }
  if (now - Math.max(state.lastActivityAt, state.lastIdleConsideredAt ?? state.lastActivityAt) >= 75_000) {
    state.lastIdleConsideredAt = now;
    return result('consider', 'extended_idle');
  }
  return result('silent', 'quiet');
}
