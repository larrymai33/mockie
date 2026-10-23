/** All timestamps crossing an API/queue boundary are ISO 8601 strings. */
export type Language = 'python' | 'javascript';
export type ProviderMode = 'offline' | 'online';
export type SessionStatus = 'active' | 'ended';

export interface RunJob {
  id: string;
  sessionId: string;
  language: Language;
  code: string;
  createdAt: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  jobId: string;
  sessionId: string;
  status: 'success' | 'error' | 'timeout' | 'rejected';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  completedAt: string;
}

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface Problem {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'custom';
  description: string;
  examples: ProblemExample[];
  constraints: string[];
  starterCode: Record<Language, string>;
}

export type ScoreCategory = 'communication' | 'problem_solving' | 'coding' | 'testing' | 'complexity';

export interface CategoryScore {
  key: ScoreCategory;
  score: number;
  feedback: string;
}

export interface Scorecard {
  summary: string;
  categories: CategoryScore[];
  strengths: string[];
  improvements: string[];
  source: 'model' | 'fallback' | 'offline';
}

export interface TranscriptEntry {
  id: string;
  role: 'candidate' | 'interviewer';
  text: string;
  createdAt: string;
}

export interface Session {
  id: string;
  problem: Problem;
  language: Language;
  durationMinutes: number;
  providerMode: ProviderMode;
  status: SessionStatus;
  code: string;
  codeRevision: number;
  startedAt: string;
  endedAt: string | null;
  transcript: TranscriptEntry[];
  runs: RunResult[];
  scorecard: Scorecard | null;
}

export interface AppSettings {
  providerMode: ProviderMode;
  baseUrl: string;
  model: string;
  apiKey: string;
  defaultDurationMinutes: number;
  autoSpeak: boolean;
  autoListen: boolean;
}

export type SessionEvent =
  | { type: 'session_updated'; session: Session }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'run_result'; result: RunResult }
  | { type: 'status'; status: 'listening' | 'reviewing' | 'speaking' | 'offline'; message?: string }
  | { type: 'recoverable_error'; source: 'provider' | 'runner'; message: string };

export interface InterviewContext {
  problem: Problem;
  language: Language;
  code: string;
  transcript: TranscriptEntry[];
  runs: RunResult[];
  elapsedMs: number;
  durationMs: number;
  trigger?: string;
  candidateMessage?: string;
}

export interface InterviewerDecision {
  action: 'speak' | 'silent';
  message: string;
}

export interface InterviewProvider {
  readonly mode: ProviderMode;
  respond(context: InterviewContext): Promise<InterviewerDecision>;
  score(context: InterviewContext): Promise<Scorecard>;
}
