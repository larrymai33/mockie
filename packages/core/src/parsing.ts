import { z } from 'zod';
import type { InterviewContext, InterviewerDecision, Scorecard } from './contracts.js';
import { SCORECARD_RUBRIC_VERSION } from './rubric.js';

export const scoreCategories = ['communication', 'problem_solving', 'coding', 'testing', 'complexity'] as const;

const text = z.string().trim().min(1);
const evidenceSchema = z.object({
  source: z.enum(['code', 'transcript', 'run']), id: text.optional(), quote: text,
}).refine(evidence => evidence.source === 'code' ? evidence.id === undefined : evidence.id !== undefined);
const scorecardSchema = z.object({
  rubricVersion: z.literal(SCORECARD_RUBRIC_VERSION).optional(),
  summary: text,
  categories: z.array(z.object({
    key: z.enum(scoreCategories), score: z.number().int().min(1).max(5).nullable(), feedback: text,
    assistance: z.enum(['independent', 'prompted', 'guided', 'not_observed']).optional(),
    evidence: z.array(evidenceSchema).max(5).optional(),
  })).length(5)
    .refine(categories => new Set(categories.map(category => category.key)).size === 5),
  strengths: z.array(text),
  improvements: z.array(text),
});

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input.trim()) as unknown;
  } catch {
    try {
      // Match the outer block; inline fences inside JSON strings are content.
      const fenced = input.match(/```(?:json)?\s*([\s\S]*)```/i);
      return fenced?.[1] ? JSON.parse(fenced[1].trim()) as unknown : null;
    } catch {
      return null;
    }
  }
}

export function parseInterviewerDecision(input: string): InterviewerDecision {
  const parsed = z.object({ action: z.enum(['speak', 'silent']), message: z.string().optional() }).safeParse(parseJson(input));
  if (!parsed.success || parsed.data.action === 'silent' || !parsed.data.message?.trim()) return { action: 'silent', message: '' };
  return { action: 'speak', message: parsed.data.message.trim() };
}

/** Invalid output returns null so the caller can generate a context-aware fallback. */
export function parseScorecard(input: string, context?: InterviewContext): Scorecard | null {
  const parsed = scorecardSchema.safeParse(parseJson(input));
  if (!parsed.success) return null;
  const card = parsed.data;
  // Legacy scorecards are readable, but new online scores must use the rubric.
  if (context && card.rubricVersion !== SCORECARD_RUBRIC_VERSION) return null;
  if (card.rubricVersion) {
    for (const category of card.categories) {
      if (!category.assistance || !category.evidence) return null;
      if (category.score !== null && category.evidence.length === 0) return null;
      if (context && category.evidence.some(evidence => !matchesEvidence(evidence, context))) return null;
    }
  }
  return {
    summary: card.summary, strengths: card.strengths, improvements: card.improvements, source: 'model',
    ...(card.rubricVersion ? { rubricVersion: card.rubricVersion } : {}),
    categories: card.categories.map(category => ({
      key: category.key, score: category.score, feedback: category.feedback,
      ...(category.assistance ? { assistance: category.assistance } : {}),
      ...(category.evidence ? { evidence: category.evidence.map(evidence => ({
        source: evidence.source, quote: evidence.quote, ...(evidence.id ? { id: evidence.id } : {}),
      })) } : {}),
    })),
  };
}

/** Check provenance, not the model's interpretation. A real quote can still be misjudged. */
function matchesEvidence(evidence: z.infer<typeof evidenceSchema>, context: InterviewContext): boolean {
  if (evidence.source === 'code') {
    // A change elsewhere in the file must not turn supplied scaffold into work
    // attributed to the candidate. Ask for an excerpt including an actual edit.
    return context.code.includes(evidence.quote)
      && !context.problem.starterCode[context.language].includes(evidence.quote);
  }
  if (evidence.source === 'transcript') {
    return context.transcript.some(entry => entry.id === evidence.id && entry.role === 'candidate' && entry.text.includes(evidence.quote));
  }
  const run = context.runs.find(result => result.jobId === evidence.id);
  return !!run && (run.stdout.includes(evidence.quote) || run.stderr.includes(evidence.quote) || evidence.quote === run.status);
}
