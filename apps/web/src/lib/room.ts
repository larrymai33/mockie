import type { RoomApi, RunResult, Scorecard, Session, StartOptions, TranscriptEntry } from './types';

export interface RoomState {
  phase: 'lobby' | 'starting' | 'room' | 'scorecard';
  session: Session | null;
  code: string;
  remainingSeconds: number;
  output: RunResult | null;
  scorecard: Scorecard | null;
  running: boolean;
  ending: boolean;
  sending: boolean;
  error: string | null;
  notice: string | null;
  status: string;
  saved: boolean;
}
const initial = (): RoomState => ({ phase: 'lobby', session: null, code: '', remainingSeconds: 0, output: null, scorecard: null, running: false, ending: false, sending: false, error: null, notice: null, status: 'offline', saved: true });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';

export class RoomController {
  state = initial();
  private listeners = new Set<() => void>();
  private debounce?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private revision = 0;
  private savedCode = '';
  constructor(private api: RoomApi) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private patch(update: Partial<RoomState>) { this.state = { ...this.state, ...update }; this.listeners.forEach(listener => listener()); }
  async start(options: StartOptions) {
    this.patch({ phase: 'starting', error: null });
    try { this.open(await this.api.start(options)); }
    catch (error) { this.patch({ phase: 'lobby', error: errorMessage(error) }); }
  }
  open(session: Session) {
    this.stop();
    this.revision = 0;
    this.savedCode = session.code;
    const ended = session.status === 'ended';
    const elapsed = Math.max(0, (Date.now() - Date.parse(session.startedAt)) / 1000);
    this.patch({ ...initial(), session, phase: ended ? 'scorecard' : 'room', code: session.code, scorecard: session.scorecard ?? null, output: session.runs.at(-1) ?? null, remainingSeconds: Math.max(0, Math.ceil(session.durationMinutes * 60 - elapsed)), status: session.mode === 'offline' ? 'offline' : 'listening' });
    if (!ended) {
      this.unsubscribe = this.api.subscribe(session.id, event => this.receive(event));
      this.timer = setInterval(() => { if (!this.state.ending) this.patch({ remainingSeconds: Math.max(0, Math.ceil(session.durationMinutes * 60 - (Date.now() - Date.parse(session.startedAt)) / 1000)) }); }, 1000);
    }
  }
  edit(code: string) {
    if (this.state.phase !== 'room' || this.state.ending) return;
    this.patch({ code, saved: false });
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.flush().catch(() => {}); }, 750);
  }
  async flush() {
    clearTimeout(this.debounce);
    const session = this.state.session;
    const code = this.state.code;
    if (!session || this.savedCode === code) return;
    try {
      await this.api.updateCode(session.id, code, ++this.revision);
      this.savedCode = code;
      this.patch({ saved: this.state.code === code });
    } catch (error) { this.patch({ error: `Code could not be saved: ${errorMessage(error)}`, saved: false }); throw error; }
  }
  async send(text: string, source: 'voice' | 'typed' = 'typed') {
    const session = this.state.session;
    if (!session || !text.trim() || this.state.phase !== 'room' || this.state.ending) return false;
    this.patch({ sending: true, error: null });
    try {
      await this.api.message(session.id, text.trim(), source);
      const entry: TranscriptEntry = { id: `local-${Date.now()}`, role: 'candidate', text: text.trim(), at: new Date().toISOString() };
      if (!this.state.session?.transcript.some(item => item.text === entry.text && item.role === entry.role && Date.parse(item.at) > Date.now() - 3000)) this.addTranscript(entry);
      return true;
    } catch (error) { this.patch({ error: `Message could not be sent: ${errorMessage(error)}` }); return false; }
    finally { this.patch({ sending: false }); }
  }
  async run() {
    const session = this.state.session;
    if (!session || this.state.running || this.state.ending) return;
    this.patch({ running: true, error: null, status: 'reviewing' });
    try { await this.flush(); const output = await this.api.run(session.id, this.state.code, session.language); this.patch({ output }); }
    catch (error) { this.patch({ error: errorMessage(error) }); }
    finally { this.patch({ running: false, status: session.mode === 'offline' ? 'offline' : 'listening' }); }
  }
  async end() {
    const session = this.state.session;
    if (!session || this.state.ending) return;
    this.patch({ ending: true, error: null });
    try { await this.flush(); const scorecard = await this.api.end(session.id); this.stop(); this.patch({ scorecard, phase: 'scorecard', session: { ...this.state.session!, status: 'ended', scorecard } }); }
    catch (error) {
      if (this.state.session?.status !== 'ended') this.patch({ error: `Interview could not be ended: ${errorMessage(error)}` });
    }
    finally { this.patch({ ending: false }); }
  }
  dismissError() { this.patch({ error: null }); }
  private addTranscript(entry: TranscriptEntry) { const session = this.state.session; if (session) this.patch({ session: { ...session, transcript: [...session.transcript, entry] } }); }
  receive(input: unknown) {
    if (!input || typeof input !== 'object') return;
    const envelope = input as Record<string, unknown>;
    if ((envelope.type === 'session' || envelope.type === 'session_updated') && envelope.session) {
      const incoming = envelope.session as Session;
      if (incoming.id !== this.state.session?.id) return;
      const transcript = [...(incoming.transcript ?? [])];
      for (const entry of this.state.session.transcript) {
        if (!transcript.some(item => item.id === entry.id || (item.role === entry.role && item.text === entry.text && Math.abs(Date.parse(item.at) - Date.parse(entry.at)) < 3000))) transcript.push(entry);
      }
      transcript.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      const session = { ...incoming, transcript, code: this.state.code };
      this.patch({ session, ...(incoming.runs?.length ? { output: incoming.runs.at(-1) } : {}) });
      if (incoming.status === 'ended') { this.stop(); this.patch({ phase: 'scorecard', scorecard: incoming.scorecard ?? null, error: null }); }
      return;
    }
    const storedEvent = (envelope.type === 'event' ? envelope.event : input) as Record<string, unknown>;
    const event = storedEvent ? { ...storedEvent, ...(storedEvent.payload && typeof storedEvent.payload === 'object' ? storedEvent.payload : {}) } as Record<string, unknown> : null;
    if (!event) return;
    if (event.type === 'status' || event.type === 'provider_error' || event.type === 'runner_error' || event.type === 'system_status' || event.type === 'recoverable_error') {
      this.patch({ status: String(event.status ?? 'offline'), notice: String(event.message ?? 'The interviewer is temporarily unavailable. You can continue coding.') });
    } else if (event.type === 'interviewer_message' || event.type === 'candidate_message') {
      const role = event.type === 'interviewer_message' ? 'interviewer' : 'candidate';
      const text = String(event.text ?? '');
      if (this.state.session?.transcript.some(item => item.text === text && item.role === role && Date.parse(item.at) > Date.now() - 3000)) return;
      this.addTranscript({ id: String(event.id ?? `event-${Date.now()}`), role, text, at: String(event.at ?? event.createdAt ?? new Date().toISOString()) });
    } else if (event.type === 'transcript') {
      const entry = event.entry as TranscriptEntry & { createdAt?: string };
      this.addTranscript({ ...entry, at: entry.at ?? entry.createdAt ?? new Date().toISOString() });
    } else if (event.type === 'run_result') {
      const raw = (event.run ?? event.result ?? event) as RunResult & { jobId?: string };
      this.patch({ output: { ...raw, id: raw.id ?? raw.jobId ?? '', timedOut: raw.timedOut ?? raw.status === 'timeout' } });
    }
  }
  back() { this.stop(); this.patch(initial()); }
  private stop() { clearTimeout(this.debounce); clearInterval(this.timer); this.unsubscribe?.(); this.unsubscribe = undefined; }
  dispose() { this.stop(); this.listeners.clear(); }
}
