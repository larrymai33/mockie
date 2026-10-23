export type Language = 'python' | 'javascript';
export type Mode = 'offline' | 'online';
export interface Problem { id: string; title: string; description: string; difficulty?: string; starterCode: Record<Language, string>; examples?: Array<{ input: string; output: string; explanation?: string }>; constraints?: string[] }
export interface TranscriptEntry { id: string; role: 'candidate' | 'interviewer'; text: string; at: string }
export interface RunResult { id: string; stdout: string; stderr: string; exitCode: number | null; durationMs?: number; timedOut?: boolean; truncated?: boolean; status?: string }
export interface Scorecard { summary: string; overall?: number; categories: Array<{ name: string; score: number; feedback: string }>; strengths: string[]; improvements: string[]; source?: string }
export interface Session { id: string; problem: Problem; language: Language; durationMinutes: number; mode: Mode; code: string; status: string; startedAt: string; endedAt?: string; transcript: TranscriptEntry[]; runs: RunResult[]; scorecard?: Scorecard }
export interface StartOptions { problemId?: string; customProblem?: string; language: Language; durationMinutes: number; mode: Mode }
export interface Settings { mode: Mode; model: string; baseUrl?: string; [key: string]: unknown }
export interface RoomApi {
  start(options: StartOptions): Promise<Session>;
  updateCode(id: string, code: string, revision: number): Promise<void>;
  message(id: string, text: string, source: 'voice' | 'typed'): Promise<void>;
  run(id: string, code: string, language: Language): Promise<RunResult>;
  end(id: string): Promise<Scorecard>;
  subscribe(id: string, onEvent: (event: unknown) => void): () => void;
}
export interface AppApi extends RoomApi {
  problems(): Promise<Problem[]>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  history(): Promise<Session[]>;
  session(id: string): Promise<Session>;
}
