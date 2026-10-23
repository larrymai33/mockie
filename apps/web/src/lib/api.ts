import type { AppApi, Problem, RunResult, Scorecard, Session, Settings, TranscriptEntry } from './types';

type Data = Record<string, any>;
const categoryNames: Record<string, string> = { communication: 'Communication', problem_solving: 'Problem solving', coding: 'Coding', testing: 'Testing', complexity: 'Complexity' };
function scorecard(raw: Data | null | undefined): Scorecard | undefined {
  if (!raw) return undefined;
  return { ...raw, categories: (raw.categories ?? []).map((item: Data) => ({ ...item, name: item.name ?? categoryNames[item.key] ?? item.key })), strengths: raw.strengths ?? [], improvements: raw.improvements ?? [] } as Scorecard;
}
function normalizeRun(raw: Data): RunResult { return { ...raw, id: raw.id ?? raw.jobId, timedOut: raw.timedOut ?? raw.status === 'timeout' } as RunResult; }
function normalizeSettings(raw: Data): Settings { const { providerMode, ...rest } = raw; return { ...rest, mode: providerMode ?? raw.mode ?? 'offline' } as Settings; }
function problem(raw: Data): Problem {
  return { ...raw, id: raw.id ?? 'custom', title: raw.title ?? 'Custom problem', description: raw.description ?? raw.statement ?? '', starterCode: raw.starterCode ?? raw.starters ?? { python: '# Write your solution here\n', javascript: '// Write your solution here\n' } } as Problem;
}
function transcript(events: Data[]): TranscriptEntry[] {
  return events.filter(event => event.type === 'candidate_message' || event.type === 'interviewer_message').map(event => ({ id: event.id, role: event.type === 'candidate_message' ? 'candidate' : 'interviewer', text: event.text ?? event.payload?.text ?? '', at: event.at ?? event.createdAt }));
}
function normalizeSession(raw: Data, events: Data[] = []): Session {
  const entries = raw.transcript ?? transcript(events);
  return { ...raw, problem: problem(raw.problem ?? { title: raw.problemTitle ?? 'Interview', description: raw.customProblem ?? '' }), startedAt: raw.startedAt ?? raw.createdAt, mode: raw.providerMode ?? raw.mode ?? 'offline', durationMinutes: raw.durationMinutes ?? 45, code: raw.code ?? '', transcript: entries.map((entry: Data) => ({ ...entry, at: entry.at ?? entry.createdAt })), runs: (raw.runs ?? []).map(normalizeRun), scorecard: scorecard(raw.scorecard) } as Session;
}
export function createApi(fetcher: typeof fetch = (...args) => fetch(...args)): AppApi {
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetcher(`/api${path}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    let data: Data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Try again.'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message ?? data.error?.message ?? `Request failed (${response.status}). Try again.`);
    return data;
  }
  return {
    async problems() { const data = await request('/problems'); return (data.problems ?? data).map(problem); },
    async settings() { const data = await request('/settings'); return normalizeSettings(data.settings ?? data); },
    async saveSettings(settings) { const { mode, ...rest } = settings; const data = await request('/settings', 'PATCH', { ...rest, providerMode: mode }); return normalizeSettings(data.settings ?? data); },
    async history() { const data = await request('/sessions'); return (data.sessions ?? data).map((item: Data) => normalizeSession(item)); },
    async session(id) { const data = await request(`/sessions/${encodeURIComponent(id)}`); return normalizeSession(data.session ?? data, data.events ?? []); },
    async start(options) { const body = { ...options, ...(options.customProblem ? { customProblem: { title: 'Custom problem', description: options.customProblem } } : {}) }; const data = await request('/sessions', 'POST', body); return normalizeSession(data.session ?? data, data.events ?? []); },
    async updateCode(id, code, revision) { await request(`/sessions/${encodeURIComponent(id)}/events`, 'POST', { type: 'code_change', code, revision }); },
    async message(id, text, source) { await request(`/sessions/${encodeURIComponent(id)}/events`, 'POST', { type: 'candidate_message', text, source }); },
    async run(id, code, language) { const data = await request(`/sessions/${encodeURIComponent(id)}/run`, 'POST', { code, language }); return normalizeRun(data.run ?? data); },
    async end(id) { const data = await request(`/sessions/${encodeURIComponent(id)}/end`, 'POST'); return scorecard(data.scorecard ?? data.session?.scorecard ?? data)!; },
    subscribe(id, onEvent) {
      let closed = false;
      let socket: WebSocket | undefined;
      let retry: ReturnType<typeof setTimeout>;
      let attempts = 0;
      function connect() {
        if (closed) return;
        const url = new URL('/ws', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('sessionId', id);
        socket = new WebSocket(url);
        socket.onopen = () => { attempts = 0; onEvent({ type: 'status', status: 'listening', message: 'Connected. Your interviewer is quietly following along.' }); void request(`/sessions/${encodeURIComponent(id)}`).then(data => { if (!closed) onEvent({ type: 'session', session: normalizeSession(data.session ?? data, data.events ?? []) }); }).catch(() => {}); };
        socket.onmessage = message => { try { const data = JSON.parse(String(message.data)); if (data.type === 'session' && data.session) data.session = normalizeSession(data.session); onEvent(data); } catch { onEvent({ type: 'status', status: 'offline', message: 'A room update could not be read. Your code is safe.' }); } };
        socket.onclose = () => { if (closed) return; onEvent({ type: 'status', status: 'offline', message: 'Room connection interrupted. Reconnecting; you can keep coding.' }); retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000)); };
        socket.onerror = () => socket?.close();
      }
      connect();
      return () => { closed = true; clearTimeout(retry); socket?.close(); };
    }
  };
}
export const api = createApi();
