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

  it.each([
    ['How should I analyze time and space complexity?', /input size|operation|memory|space|complexity/i],
    ['How do I know this approach is correct?', /invariant|correct|holds|reason/i],
    ['What tradeoff should I consider?', /tradeoff|trade-off|alternative|cost/i],
    ['What tests should I try next?', /expected|boundary|edge|test/i],
    ['I am stuck; can I have a hint?', /example|stuck|step|information/i],
  ])('follows up on the candidate topic: %s', async (candidateMessage, topic) => {
    const reply = await new OfflineProvider().respond(context({ candidateMessage, trigger: 'direct_message' }));
    expect(reply.action).toBe('speak');
    expect(reply.message).toMatch(topic);
    expect(reply.message.match(/\?/g)).toHaveLength(1);
    expect(reply.message).not.toMatch(/def |function |```/);
  });

  it('progresses through follow-ups using persisted interviewer history after a provider restart', async () => {
    const first = await new OfflineProvider().respond(context({ trigger: 'extended_idle' }));
    const second = await new OfflineProvider().respond(context({
      trigger: 'extended_idle',
      transcript: [{ id: 'interviewer-1', role: 'interviewer', text: first.message, createdAt: '2026-10-23T03:00:00.000Z' }],
    }));
    expect(first.action).toBe('speak');
    expect(second.action).toBe('speak');
    expect(second.message).not.toBe(first.message);
    expect(second.message.match(/\?/g)).toHaveLength(1);
  });

  it.each(['extended_idle', 'run_completed', 'time_checkpoint'])('stops automatic %s prompts when its follow-ups are exhausted', async trigger => {
    const interview = context({ trigger, runs: [successfulRun] });
    const questions = new Set<string>();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reply = await new OfflineProvider().respond(interview);
      if (reply.action === 'silent') {
        expect(questions.size).toBeGreaterThan(1);
        return;
      }
      expect(questions.has(reply.message)).toBe(false);
      questions.add(reply.message);
      interview.transcript.push({ id: `interviewer-${attempt}`, role: 'interviewer', text: reply.message, createdAt: '2026-10-23T03:00:00.000Z' });
      // A changing clock must not make an old checkpoint question appear new.
      interview.elapsedMs += 60_000;
    }
    expect.fail('Automatic scripted follow-ups must eventually stop.');
  });

  it('still answers a direct question after the scripted topic has been exhausted', async () => {
    const interview = context({ trigger: 'direct_message', candidateMessage: 'How can I prove correctness?' });
    const questions = new Set<string>();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reply = await new OfflineProvider().respond(interview);
      expect(reply.action).toBe('speak');
      if (!reply.message.includes('?')) {
        expect(reply.message).toMatch(/offline|script/i);
        expect(reply.message).toMatch(/cannot|unable|limit|no additional/i);
        return;
      }
      expect(questions.has(reply.message)).toBe(false);
      questions.add(reply.message);
      interview.transcript.push({ id: `interviewer-${attempt}`, role: 'interviewer', text: reply.message, createdAt: '2026-10-23T03:00:00.000Z' });
    }
    expect.fail('Exhausted direct topics should disclose the scripted limit.');
  });

  it('uses the last candidate transcript when a direct event has no duplicate message field', async () => {
    const reply = await new OfflineProvider().respond(context({
      trigger: 'direct_message',
      transcript: [{ id: 'candidate-1', role: 'candidate', text: 'What is the space complexity?', createdAt: '2026-10-23T03:00:00.000Z' }],
    }));
    expect(reply.message).toMatch(/input size|operation|memory|space|complexity/i);
  });
});

describe('fallback scorecard', () => {
  it('discloses unavailable judgment and does not invent correctness from a successful process', () => {
    const score = createFallbackScorecard(context({ code: 'print(1)', runs: [successfulRun] }));
    expect(score.source).toBe('fallback');
    expect(score.summary).toMatch(/limited|local|unavailable/i);
    expect(score.categories.find(category => category.key === 'testing')?.feedback).toMatch(/does not|not prove|not verified/i);
    expect(score.categories.find(category => category.key === 'testing')?.score).toBeNull();
  });

  it('uses actual communication and run evidence to generate useful next steps', () => {
    const score = createFallbackScorecard(context({
      transcript: [{ id: 'message-1', role: 'candidate', text: 'I can use a lookup to avoid repeated work.', createdAt: '2026-10-23T03:00:00.000Z' }],
      runs: [{ ...successfulRun, status: 'error', stderr: 'SyntaxError', exitCode: 1 }],
    }));
    expect(score.strengths.join(' ')).toMatch(/1 candidate message/i);
    expect(score.improvements.join(' ')).toMatch(/error|run/i);
    expect(score.categories).toHaveLength(5);
  });

  it.each([false, true])('leaves competence ungraded regardless of recorded activity (%s)', async active => {
    const interview = context(active ? {
      code: 'print(1)',
      transcript: Array.from({ length: 10 }, (_, index) => ({
        id: `candidate-${index}`, role: 'candidate' as const, text: 'hello', createdAt: '2026-10-23T03:00:00.000Z',
      })),
      runs: [successfulRun, successfulRun],
    } : {});
    for (const score of [createFallbackScorecard(interview), await new OfflineProvider().score(interview)]) {
      expect(score.rubricVersion).toBe('senior-swe-v1');
      expect(score.summary).toMatch(/ungraded|not graded|no.*grade|cannot assess/i);
      expect(score.categories.map(category => category.key)).toEqual(['communication', 'problem_solving', 'coding', 'testing', 'complexity']);
      for (const category of score.categories) {
        expect(category.score).toBeNull();
        expect(category.assistance).toBe('not_observed');
        expect(category.evidence).toEqual([]);
        expect(category.feedback.length).toBeGreaterThan(35);
      }
    }
  });

  it('does not describe arbitrary candidate messages as demonstrated reasoning', () => {
    const score = createFallbackScorecard(context({
      transcript: [{ id: 'candidate-1', role: 'candidate', text: 'hello', createdAt: '2026-10-23T03:00:00.000Z' }],
    }));
    expect(score.strengths.join(' ')).not.toMatch(/communicated.*reason|shared.*reason|asked.*clarif/i);
    expect(score.categories[0]?.feedback).toMatch(/1.*message/i);
  });
});
