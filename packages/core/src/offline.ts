import type { InterviewContext, InterviewerDecision, InterviewProvider, Scorecard } from './contracts.js';

/** Local evidence summary, deliberately conservative about qualities it cannot assess. */
export function createFallbackScorecard(context: InterviewContext): Scorecard {
  const messages = context.transcript.filter(entry => entry.role === 'candidate' && entry.text.trim());
  const changedCode = context.code.trim() !== context.problem.starterCode[context.language].trim();
  const successes = context.runs.filter(run => run.status === 'success').length;
  const failures = context.runs.filter(run => run.status !== 'success').length;
  return {
    source: 'fallback',
    summary: 'Local review based on limited session evidence. Model judgment was unavailable; these provisional scores do not verify a solution.',
    categories: [
      { key: 'communication', score: messages.length ? 3 : 1, feedback: messages.length ? `You shared ${messages.length} explanation or question${messages.length === 1 ? '' : 's'}. Practice stating the invariant behind your approach.` : 'No spoken or typed candidate explanation was recorded. Explain your approach before coding.' },
      { key: 'problem_solving', score: changedCode ? 2 : 1, feedback: changedCode ? 'You developed the initial code. Approach quality needs a human or model review.' : 'The starter code was unchanged. Work through a small example and propose an approach.' },
      { key: 'coding', score: changedCode ? 2 : 1, feedback: changedCode ? 'Code was edited, but readability and correctness were not verified by this local review.' : 'No implementation change was recorded.' },
      { key: 'testing', score: context.runs.length ? 2 : 1, feedback: `${context.runs.length} run${context.runs.length === 1 ? '' : 's'} recorded; ${successes} exited successfully and ${failures} failed or were rejected. A successful exit does not prove correctness or test coverage.` },
      { key: 'complexity', score: 1, feedback: 'Time and space complexity were not verified. State the input size, operation count, and auxiliary memory use.' },
    ],
    strengths: [
      ...(messages.length ? ['You communicated your reasoning or asked a clarifying question.'] : []),
      ...(changedCode ? ['You worked on an implementation.'] : []),
      ...(context.runs.length ? ['You used code execution to collect feedback.'] : []),
    ],
    improvements: [
      ...(failures ? ['Inspect the run error output, fix the cause, and rerun the same example.'] : []),
      'Check examples and boundary cases against explicit expected outputs.',
      'Explain why the approach works and analyze time and space complexity.',
    ],
  };
}

export class OfflineProvider implements InterviewProvider {
  readonly mode = 'offline' as const;

  async respond(context: InterviewContext): Promise<InterviewerDecision> {
    const speak = (message: string): InterviewerDecision => ({ action: 'speak', message });
    if (context.candidateMessage?.trim() || context.trigger === 'direct_message') {
      if (/constraint|assum|duplicate|empty|sorted|input/i.test(context.candidateMessage ?? '')) {
        return speak(`The problem's constraints are: ${context.problem.constraints.join(' ')} What assumption would you like to check against an example?`);
      }
      return speak('Start with a small example and describe the information you need at each step. What approach are you considering?');
    }
    if (context.trigger === 'run_completed') {
      const latest = context.runs.at(-1);
      if (latest && latest.status !== 'success') return speak('The latest run reported an error or could not finish. What does the output tell you about the next thing to check?');
      if (latest) return speak('That run completed. Which edge case would best test your reasoning next?');
    }
    if (context.trigger === 'extended_idle') return speak('Take a moment to walk through a small example. Where does your current reasoning get stuck?');
    if (context.trigger === 'time_checkpoint') {
      const remaining = Math.max(0, Math.ceil((context.durationMs - context.elapsedMs) / 60_000));
      return speak(`About ${remaining} minute${remaining === 1 ? '' : 's'} remain. What will you prioritize: the implementation, an edge case, or a complexity check?`);
    }
    return { action: 'silent', message: '' };
  }

  async score(context: InterviewContext): Promise<Scorecard> {
    return { ...createFallbackScorecard(context), source: 'offline', summary: 'Offline practice review based on limited local evidence. These provisional scores do not verify a solution.' };
  }
}
