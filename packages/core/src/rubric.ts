import type { ScoreCategory } from './contracts.js';

/** Versioned so historical scorecards do not silently acquire new standards. */
export const SCORECARD_RUBRIC_VERSION = 'senior-swe-v1' as const;

export const scoreScale = [
  { score: 1, label: 'Significant gaps' },
  { score: 2, label: 'Developing' },
  { score: 3, label: 'Meets expectations' },
  { score: 4, label: 'Strong' },
  { score: 5, label: 'Exceptional' },
] as const;

export interface RubricCategory {
  key: ScoreCategory;
  title: string;
  anchors: Record<1 | 2 | 3 | 4 | 5, string>;
}

/** Shared by the model prompt and the scorecard guide; applies to this coding round only. */
export const scoringRubric: readonly RubricCategory[] = [
  {
    key: 'communication', title: 'Communication', anchors: {
      1: 'Explanations remain contradictory or unclear after a neutral clarification; assumptions stay hidden.',
      2: 'Describes steps, but needs repeated prompts to explain decisions or resolve ambiguous requirements.',
      3: 'Clarifies relevant requirements, explains a coherent plan and key decisions, and responds to feedback.',
      4: 'Makes assumptions and tradeoffs explicit, communicates changes of plan, and checks shared understanding concisely.',
      5: 'Independently surfaces consequential ambiguity, explains reasoning precisely, and makes difficult tradeoffs easy to follow.',
    },
  },
  {
    key: 'problem_solving', title: 'Problem solving', anchors: {
      1: 'The proposed approach violates a stated requirement and the candidate cannot repair the reasoning after clarification.',
      2: 'Finds a partial or brute-force approach but needs substantive hints for a workable strategy or correctness argument.',
      3: 'Develops a viable approach, explains why it works, and considers a relevant alternative with at most neutral probing.',
      4: 'Independently compares viable approaches, justifies an invariant or equivalent correctness argument, and adapts to a counterexample.',
      5: 'Derives the key insight independently, explains assumptions and limits rigorously, and handles a relevant follow-up without losing correctness.',
    },
  },
  {
    key: 'coding', title: 'Coding', anchors: {
      1: 'The candidate-written implementation has major correctness gaps that remain unresolved in the available evidence.',
      2: 'The implementation is partial or fragile and requires substantial guidance to handle the stated contract.',
      3: 'Produces a readable implementation consistent with the chosen approach and handles the relevant boundary conditions shown.',
      4: 'Writes clear, focused code with appropriate data structures, maintains the reasoning invariant, and independently fixes defects.',
      5: 'Produces a simple, robust implementation whose structure exposes correctness and accommodates a relevant change with little added complexity.',
    },
  },
  {
    key: 'testing', title: 'Testing', anchors: {
      1: 'Explicit testing reasoning is unsound: accepts a demonstrated mismatch or treats a failed case as correct after clarification.',
      2: 'Checks a happy path but needs prompting for expected results, boundaries, or a regression check after a fix.',
      3: 'Checks representative and boundary cases against explicit expected results and uses failures to guide debugging.',
      4: 'Independently selects adversarial cases tied to the algorithm, traces failures, and verifies repairs with regression checks.',
      5: 'Explains a systematic coverage strategy, tests invariants or properties where useful, and distinguishes demonstrated behavior from untested assumptions.',
    },
  },
  {
    key: 'complexity', title: 'Complexity', anchors: {
      1: 'The stated analysis is materially wrong and remains unsupported or incorrect after a neutral probe.',
      2: 'Identifies one dominant cost but misses relevant operations or auxiliary memory without substantial prompting.',
      3: 'Correctly explains time and auxiliary space for the actual implementation, defining the relevant input sizes.',
      4: 'Accounts for sorting, copies, recursion or data-structure assumptions as applicable and explains a relevant time-space tradeoff.',
      5: 'Justifies relevant worst-case or amortized bounds, identifies when assumptions break, and compares alternatives under changed constraints.',
    },
  },
];
