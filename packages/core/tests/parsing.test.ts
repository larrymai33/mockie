import { describe, expect, it } from 'vitest';
import { parseInterviewerDecision, parseScorecard } from '../src/index.js';

describe('structured provider output', () => {
  it.each([
    '{"action":"speak","message":"What happens for empty input?"}',
    '```json\n{"action":"speak","message":"What happens for empty input?"}\n```',
    'Here is my decision:\n```json\n{"action":"speak","message":"What happens for empty input?"}\n```',
  ])('accepts valid plain or fenced JSON: %s', (input) => {
    expect(parseInterviewerDecision(input)).toEqual({ action: 'speak', message: 'What happens for empty input?' });
  });

  it.each(['not JSON', '{}', '{"action":"speak"}', '{"action":"speak","message":"  "}', '{"action":"dance","message":"hello"}', 'null', '[]'])
    ('falls back to silence for malformed or incomplete decisions: %s', (input) => {
      expect(parseInterviewerDecision(input)).toEqual({ action: 'silent', message: '' });
    });

  it('normalizes silent decisions without leaking stray provider text', () => {
    expect(parseInterviewerDecision('{"action":"silent","message":"internal thought"}')).toEqual({ action: 'silent', message: '' });
  });

  it.each([false, true])('preserves literal Markdown fences inside a JSON message (outer fence: %s)', (fenced) => {
    const json = JSON.stringify({ action: 'speak', message: 'What does ```text``` mean in your sample input?' });
    expect(parseInterviewerDecision(fenced ? '```json\n' + json + '\n```' : json))
      .toEqual({ action: 'speak', message: 'What does ```text``` mean in your sample input?' });
  });

  it('validates a complete five-category scorecard', () => {
    const input = JSON.stringify({
      summary: 'A thoughtful approach.',
      categories: [
        { key: 'problem_solving', score: 3, feedback: 'Considered alternatives.' },
        { key: 'testing', score: 2, feedback: 'Missed an edge case.' },
        { key: 'coding', score: 4, feedback: 'Clear naming.' },
        { key: 'communication', score: 3, feedback: 'Explained decisions.' },
        { key: 'complexity', score: 2, feedback: 'Analyze memory use.' },
      ],
      strengths: ['Clear naming'], improvements: ['Test empty inputs'],
    });
    expect(parseScorecard('```json\n' + input + '\n```')).toMatchObject({ source: 'model', summary: 'A thoughtful approach.' });
    expect(parseScorecard(input)?.categories).toHaveLength(5);
  });

  it.each([
    'not JSON', '{}', '{"summary":"fine","categories":[]}',
    JSON.stringify({ summary: 'fine', categories: Array.from({ length: 5 }, () => ({ key: 'coding', score: 9, feedback: 'fine' })), strengths: [], improvements: [] }),
    JSON.stringify({ summary: 'fine', categories: Array.from({ length: 5 }, () => ({ key: 'coding', score: 3, feedback: 'fine' })), strengths: [], improvements: [] }),
  ])('rejects invalid scorecards so the caller can save a local fallback: %s', (input) => {
    expect(parseScorecard(input)).toBeNull();
  });
});
