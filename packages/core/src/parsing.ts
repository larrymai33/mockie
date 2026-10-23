import { z } from 'zod';
import type { InterviewerDecision, Scorecard } from './contracts.js';

export const scoreCategories = ['communication', 'problem_solving', 'coding', 'testing', 'complexity'] as const;

const text = z.string().trim().min(1);
const scorecardSchema = z.object({
  summary: text,
  categories: z.array(z.object({ key: z.enum(scoreCategories), score: z.number().int().min(1).max(5), feedback: text })).length(5)
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
export function parseScorecard(input: string): Scorecard | null {
  const parsed = scorecardSchema.safeParse(parseJson(input));
  return parsed.success ? { ...parsed.data, source: 'model' } : null;
}
