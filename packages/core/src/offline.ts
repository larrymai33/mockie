import type { CategoryScore, InterviewContext, InterviewerDecision, InterviewProvider, Scorecard } from './contracts.js';
import { SCORECARD_RUBRIC_VERSION } from './rubric.js';

/** Activity is observable locally; competence and assistance quality are not. */
export function createFallbackScorecard(context: InterviewContext): Scorecard {
  const messages = context.transcript.filter(entry => entry.role === 'candidate' && entry.text.trim());
  const changedCode = context.code.trim() !== context.problem.starterCode[context.language].trim();
  const successes = context.runs.filter(run => run.status === 'success').length;
  const failures = context.runs.filter(run => run.status !== 'success').length;
  const ungraded = (key: CategoryScore['key'], feedback: string): CategoryScore => ({
    key, score: null, feedback, evidence: [], assistance: 'not_observed',
  });
  return {
    source: 'fallback',
    rubricVersion: SCORECARD_RUBRIC_VERSION,
    summary: 'Ungraded local activity review. Model judgment was unavailable; activity counts cannot assess senior SWE competence or verify a solution.',
    categories: [
      ungraded('communication', `${messages.length} candidate message${messages.length === 1 ? '' : 's'} recorded. Clarity, listening, and reasoning quality were not assessed. Practice making assumptions and decisions explicit.`),
      ungraded('problem_solving', `${changedCode ? 'The code differs from the starter.' : 'The starter code was unchanged.'} Approach quality was not assessed. Compare alternatives and explain an invariant or correctness argument.`),
      ungraded('coding', `${changedCode ? 'An implementation change was recorded.' : 'No implementation change was recorded.'} Correctness and maintainability were not assessed. Walk through the code against the agreed contract.`),
      ungraded('testing', `${context.runs.length} run${context.runs.length === 1 ? '' : 's'} recorded; ${successes} exited successfully and ${failures} failed or were rejected. A successful exit does not prove correctness or test coverage. Compare actual and expected outputs, including boundary cases.`),
      ungraded('complexity', 'Time and space complexity were not assessed. Define each input size, account for library operations and auxiliary storage, and explain the relevant tradeoffs.'),
    ],
    strengths: [
      ...(messages.length ? [`Recorded ${messages.length} candidate message${messages.length === 1 ? '' : 's'} for later review.`] : []),
      ...(changedCode ? ['Recorded an implementation change for later review.'] : []),
      ...(context.runs.length ? ['Collected execution output for later review.'] : []),
    ],
    improvements: [
      ...(failures ? ['Inspect the run error output, identify the cause, and rerun the same example.'] : []),
      'Compare two possible approaches and justify the choice using the problem constraints.',
      'Check examples and boundary cases against explicit expected outputs.',
      'Explain why the approach works and analyze time and space complexity.',
    ],
  };
}

// This is a practice script, not a code analyzer. Topic routing only selects a
// question; it never interprets keywords, edits, or process exits as competence.
const questions = {
  reasoning: [
    'Walk through a small example: what information do you need at each step?',
    'Which assumption in your current approach would you check first with a counterexample?',
    'What simpler approach could give you a baseline to compare against?',
    'What part of your reasoning is still uncertain?',
  ],
  correctness: [
    'What invariant would explain why your approach produces the required result?',
    'How does that invariant hold initially and stay true after each step?',
    'Why does termination imply the result satisfies the full problem contract?',
  ],
  complexity: [
    'How do the operation count and auxiliary memory grow with each input size?',
    'Which library operations or repeated work dominate the worst-case time?',
    'What time-space tradeoff would change if the input became much larger?',
  ],
  tradeoffs: [
    'What alternative approach would you compare, and which cost makes you prefer your current choice?',
    'Which constraint would make a different time-space tradeoff preferable?',
    'How would your choice affect readability and the effort needed to test it?',
  ],
  testing: [
    'Which boundary case would best test your reasoning, and what output do you expect?',
    'What example could distinguish your implementation from a plausible but incorrect one?',
    'How would you check the actual output against an independently derived expected result?',
  ],
  errors: [
    'What does the error output tell you about the first thing to investigate?',
    'What is the smallest input that reproduces the observed failure?',
    'After isolating the cause, what regression test would you keep?',
  ],
  constraints: [
    'Which assumption would you like to check against those constraints?',
    'What boundary example would make that assumption explicit?',
    'How does the stated contract affect the approach you would choose?',
  ],
  checkpoint: [
    'What will you prioritize next: implementation, a boundary test, or a complexity check?',
    'What is the most important unfinished claim to verify before you wrap up?',
    'How would you summarize your approach, its tradeoffs, and the remaining risks?',
  ],
} as const;

/** Transcript-based selection survives provider recreation and session reloads. */
function nextQuestion(context: InterviewContext, pool: readonly string[], prefix = '', direct = false): InterviewerDecision {
  const priorPrompts = context.transcript.filter(entry => entry.role === 'interviewer').map(entry => entry.text);
  const question = pool.find(candidate => !priorPrompts.some(previous => previous.includes(candidate)));
  if (question) return { action: 'speak', message: `${prefix}${question}` };
  if (direct) {
    return { action: 'speak', message: `${prefix}This offline script has no additional questions on that topic and cannot evaluate your answer. Continue explaining your reasoning for later review.` };
  }
  return { action: 'silent', message: '' };
}

export class OfflineProvider implements InterviewProvider {
  readonly mode = 'offline' as const;

  async respond(context: InterviewContext): Promise<InterviewerDecision> {
    if (context.candidateMessage?.trim() || context.trigger === 'direct_message') {
      const candidateMessage = context.candidateMessage?.trim() || context.transcript.filter(entry => entry.role === 'candidate').at(-1)?.text || '';
      if (/complexity|big[ -]?o|running time|space usage|auxiliary memory/i.test(candidateMessage)) {
        return nextQuestion(context, questions.complexity, '', true);
      }
      if (/correct|prove|proof|invariant|why.*work/i.test(candidateMessage)) {
        return nextQuestion(context, questions.correctness, 'I cannot validate correctness in offline mode. ', true);
      }
      if (/trade[ -]?off|alternative|optimi[sz]/i.test(candidateMessage)) {
        return nextQuestion(context, questions.tradeoffs, '', true);
      }
      if (/test|boundary|edge case/i.test(candidateMessage)) {
        return nextQuestion(context, questions.testing, '', true);
      }
      if (/constraint|assum|duplicate|empty|sorted|input|output/i.test(candidateMessage)) {
        const brief = context.problem.constraints.length
          ? `The problem's constraints are: ${context.problem.constraints.join(' ')} `
          : 'The problem brief does not specify additional constraints. ';
        return nextQuestion(context, questions.constraints, brief, true);
      }
      return nextQuestion(context, questions.reasoning, '', true);
    }
    if (context.trigger === 'run_completed') {
      const latest = context.runs.at(-1);
      if (latest && latest.status !== 'success') {
        return nextQuestion(context, questions.errors, 'The latest run reported an error or could not finish. ');
      }
      if (latest) {
        return nextQuestion(context, questions.testing, 'That process exited successfully; correctness still needs a check. ');
      }
    }
    if (context.trigger === 'extended_idle') return nextQuestion(context, questions.reasoning);
    if (context.trigger === 'time_checkpoint') {
      const remaining = Math.max(0, Math.ceil((context.durationMs - context.elapsedMs) / 60_000));
      return nextQuestion(context, questions.checkpoint, `About ${remaining} minute${remaining === 1 ? '' : 's'} remain. `);
    }
    return { action: 'silent', message: '' };
  }

  async score(context: InterviewContext): Promise<Scorecard> {
    return { ...createFallbackScorecard(context), source: 'offline', summary: 'Ungraded offline practice review. Scripted questions and local activity cannot assess senior SWE competence or verify a solution; use model or human review for rubric-based evaluation.' };
  }
}
