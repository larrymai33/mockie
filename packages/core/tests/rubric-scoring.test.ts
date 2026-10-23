import { describe, expect, it } from 'vitest';
import { getProblem, parseScorecard } from '../src/index.js';
import type { InterviewContext } from '../src/index.js';

const context: InterviewContext = {
  problem: getProblem('two-sum')!, language: 'python', code: 'def two_sum(nums, target):\n    return []',
  transcript: [
    { id: 'candidate-1', role: 'candidate', text: 'I will compare all pairs first and then consider the memory tradeoff. The nested scan is O(n^2) time and O(1) extra space.', createdAt: '2026-10-23T03:00:00Z' },
    { id: 'interviewer-1', role: 'interviewer', text: 'Can you justify the time and auxiliary space costs?', createdAt: '2026-10-23T03:01:00Z' },
  ],
  runs: [{ jobId: 'run-1', sessionId: 'session-1', status: 'error', stdout: '', stderr: 'AssertionError: expected [0, 1]', exitCode: 1, durationMs: 20, truncated: false, completedAt: '2026-10-23T03:02:00Z' }],
  elapsedMs: 120_000, durationMs: 2_700_000,
};

function scorecard() {
  return {
    rubricVersion: 'senior-swe-v1', summary: 'An initial approach was discussed; implementation is incomplete.',
    categories: [
      { key: 'communication', score: 3 as number | null, feedback: 'Outlined a baseline and an alternative to explore.', assistance: 'independent', evidence: [{ source: 'transcript', id: 'candidate-1', quote: 'I will compare all pairs first' }] },
      { key: 'problem_solving', score: 2, feedback: 'A baseline was proposed without a correctness argument yet.', assistance: 'independent', evidence: [{ source: 'transcript', id: 'candidate-1', quote: 'compare all pairs first' }] },
      { key: 'coding', score: 1, feedback: 'The return value is a placeholder rather than an implementation.', assistance: 'not_observed', evidence: [{ source: 'code', quote: 'return []' }] },
      { key: 'testing', score: 2, feedback: 'An explicit assertion caught a mismatch; no repair is recorded.', assistance: 'prompted', evidence: [{ source: 'run', id: 'run-1', quote: 'AssertionError: expected [0, 1]' }] },
      { key: 'complexity', score: 3, feedback: 'Named the time and space costs of the baseline.', assistance: 'independent', evidence: [{ source: 'transcript', id: 'candidate-1', quote: 'The nested scan is O(n^2) time and O(1) extra space.' }] },
    ],
    strengths: ['Proposed a baseline before optimizing.'], improvements: ['Implement the baseline, then verify its output against explicit expectations.'],
  };
}

describe('evidence-based rubric scoring', () => {
  it('keeps valid quotes, assistance and an unassessed category in the saved result', () => {
    const card = scorecard();
    card.categories[4]!.score = null;
    card.categories[4]!.evidence = [];
    const parsed = parseScorecard(JSON.stringify(card), context);
    expect(parsed).toMatchObject({ source: 'model', rubricVersion: 'senior-swe-v1' });
    expect(parsed?.categories[0]).toMatchObject({ score: 3, assistance: 'independent', evidence: [{ source: 'transcript', id: 'candidate-1', quote: 'I will compare all pairs first' }] });
    expect(parsed?.categories[4]).toMatchObject({ score: null, evidence: [] });
  });

  it.each([
    ['nonexistent transcript', { source: 'transcript', id: 'missing', quote: 'I will compare all pairs first' }],
    ['interviewer coaching presented as candidate reasoning', { source: 'transcript', id: 'interviewer-1', quote: 'justify the time and auxiliary space costs' }],
    ['invented candidate quote', { source: 'transcript', id: 'candidate-1', quote: 'I proved this runs in linear time.' }],
    ['invented code', { source: 'code', quote: 'return [i, j]' }],
    ['nonexistent run', { source: 'run', id: 'missing', quote: 'AssertionError: expected [0, 1]' }],
    ['invented run output', { source: 'run', id: 'run-1', quote: 'All tests passed' }],
  ])('rejects %s instead of saving an unsupported grade', (_label, evidence) => {
    const card = scorecard();
    card.categories[0]!.evidence = [evidence];
    expect(parseScorecard(JSON.stringify(card), context)).toBeNull();
  });

  it('does not allow numeric scores without cited evidence', () => {
    const card = scorecard();
    card.categories[0]!.evidence = [];
    expect(parseScorecard(JSON.stringify(card), context)).toBeNull();
  });

  it('does not award coding credit for unmodified starter code', () => {
    const card = scorecard();
    card.categories[2]!.evidence = [{ source: 'code', quote: 'pass' }];
    expect(parseScorecard(JSON.stringify(card), { ...context, code: context.problem.starterCode.python })).toBeNull();
  });

  it('does not treat copied starter text as candidate evidence after an unrelated edit', () => {
    const card = scorecard();
    card.categories[2]!.evidence = [{ source: 'code', quote: 'pass' }];
    expect(parseScorecard(JSON.stringify(card), { ...context, code: context.problem.starterCode.python + '\n# still thinking' })).toBeNull();
  });

  it('accepts an entirely unassessed session without manufacturing a low grade', () => {
    const card = scorecard();
    for (const category of card.categories) {
      category.score = null;
      category.evidence = [];
      category.assistance = 'not_observed';
      category.feedback = 'Not assessed: insufficient evidence; practice explaining this aspect next time.';
    }
    expect(parseScorecard(JSON.stringify(card), { ...context, transcript: [], runs: [], code: '' })?.categories.map(category => category.score))
      .toEqual([null, null, null, null, null]);
  });

  it('requires a known rubric and assistance assessment for new model output', () => {
    const card = scorecard();
    const { rubricVersion: _version, ...legacy } = card;
    expect(parseScorecard(JSON.stringify(legacy), context)).toBeNull();
    expect(parseScorecard(JSON.stringify({ ...card, rubricVersion: 'unknown-v9' }), context)).toBeNull();
    card.categories[0]!.assistance = 'unlimited';
    expect(parseScorecard(JSON.stringify(card), context)).toBeNull();
  });
});
