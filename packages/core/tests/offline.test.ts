import { describe, expect, it } from 'vitest';
import { OfflineProvider, builtInProblems, createFallbackScorecard, getProblem, parseScorecard } from '../src/index.js';
import type { InterviewContext, RunResult } from '../src/index.js';

const context = (overrides: Partial<InterviewContext> = {}): InterviewContext => ({
  problem: getProblem('two-sum')!, language: 'python', code: 'def two_sum(nums, target):\n    pass\n',
  transcript: [], runs: [], elapsedMs: 0, durationMs: 2_700_000, ...overrides,
});

const successfulRun: RunResult = {
  jobId: 'run-1', sessionId: 'session-1', status: 'success', stdout: '[0, 1]\n', stderr: '',
  exitCode: 0, durationMs: 35, truncated: false, completedAt: '2026-10-23T03:00:00.000Z',
};

describe('built-in problems', () => {
  it('offers executable starter signatures for both supported languages', () => {
    expect(builtInProblems.length).toBeGreaterThanOrEqual(3);
    for (const problem of builtInProblems) {
      expect(problem.description.trim().length).toBeGreaterThan(40);
      expect(problem.examples.length).toBeGreaterThan(0);
      expect(problem.starterCode.python).toMatch(/def \w+\(/);
      expect(problem.starterCode.javascript).toMatch(/function \w+\(/);
    }
    expect(getProblem('missing-problem')).toBeUndefined();
  });
});

describe('offline interviewer', () => {
  it('answers direct questions and avoids supplying replacement code', async () => {
    const reply = await new OfflineProvider().respond(context({ candidateMessage: 'What should I do next?', trigger: 'direct_message' }));
    expect(reply.action).toBe('speak');
    expect(reply.message).toMatch(/\?/);
    expect(reply.message).not.toMatch(/def |function |```/);
  });

  it('clarifies edge cases in a direct question using the problem brief', async () => {
    const reply = await new OfflineProvider().respond(context({ candidateMessage: 'What constraints should I use?', trigger: 'direct_message' }));
    expect(reply.message).toContain('two');
    expect(reply.message).toMatch(/constraint/i);
  });

  it('stays quiet at an ordinary post-edit pause', async () => {
    expect(await new OfflineProvider().respond(context({ trigger: 'post_edit_pause' }))).toEqual({ action: 'silent', message: '' });
  });

  it('offers a reasoning question after extended idle', async () => {
    expect(await new OfflineProvider().respond(context({ trigger: 'extended_idle' }))).toMatchObject({ action: 'speak', message: expect.stringMatching(/\?/) });
  });

  it('asks about run errors without claiming to know their cause', async () => {
    const reply = await new OfflineProvider().respond(context({ trigger: 'run_completed', runs: [{ ...successfulRun, status: 'error', exitCode: 1, stderr: 'NameError: missing' }] }));
    expect(reply.message).toMatch(/error|output/i);
    expect(reply.message).toMatch(/\?/);
  });

  it('asks candidates to test evidence after a successful run', async () => {
    const reply = await new OfflineProvider().respond(context({ trigger: 'run_completed', runs: [successfulRun] }));
    expect(reply.message).toMatch(/edge|test/i);
    expect(reply.message).not.toMatch(/correct solution|passed all/i);
  });

  it('produces a valid deterministic offline scorecard', async () => {
    const provider = new OfflineProvider();
    const score = await provider.score(context());
    expect(score.source).toBe('offline');
    expect(parseScorecard(JSON.stringify(score))).not.toBeNull();
    expect(await provider.score(context())).toEqual(score);
  });
});

describe('fallback scorecard', () => {
  it('discloses unavailable judgment and does not invent correctness from a successful process', () => {
    const score = createFallbackScorecard(context({ code: 'print(1)', runs: [successfulRun] }));
    expect(score.source).toBe('fallback');
    expect(score.summary).toMatch(/limited|local|unavailable/i);
    expect(score.categories.find(category => category.key === 'testing')?.feedback).toMatch(/does not|not prove|not verified/i);
    expect(score.categories.find(category => category.key === 'testing')?.score).toBeLessThanOrEqual(2);
  });

  it('uses actual communication and run evidence to generate useful next steps', () => {
    const score = createFallbackScorecard(context({
      transcript: [{ id: 'message-1', role: 'candidate', text: 'I can use a lookup to avoid repeated work.', createdAt: '2026-10-23T03:00:00.000Z' }],
      runs: [{ ...successfulRun, status: 'error', stderr: 'SyntaxError', exitCode: 1 }],
    }));
    expect(score.strengths.join(' ')).toMatch(/explain|reason|communicat/i);
    expect(score.improvements.join(' ')).toMatch(/error|run/i);
    expect(score.categories).toHaveLength(5);
  });
});
