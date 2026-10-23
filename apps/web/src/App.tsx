import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, Code2, FileText, Headphones, History, Mic, MicOff, Play, Send, Settings2, Square, Terminal, Volume2, VolumeX, X } from 'lucide-react';
import { api as defaultApi } from './lib/api';
import { RoomController } from './lib/room';
import { browserSpeechEngine, SpeechController } from './lib/speech';
import type { AppApi, Language, Mode, Problem, Session, Settings } from './lib/types';
import { CodeEditor } from './components/CodeEditor';

const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
type Page = 'practice' | 'history' | 'settings';

export function App({ api = defaultApi }: { api?: AppApi }) {
  const [controller] = useState(() => new RoomController(api));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [page, setPage] = useState<Page>('practice');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [settings, setSettings] = useState<Settings>({ mode: 'offline', model: 'offline' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<Session[]>([]);
  const [review, setReview] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { const [catalog, currentSettings] = await Promise.all([api.problems(), api.settings()]); setProblems(catalog); setSettings(currentSettings); }
    catch (error) { setLoadError(error instanceof Error ? error.message : 'Could not connect to the server.'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); return () => controller.dispose(); }, [load, controller]);
  useEffect(() => {
    if (page !== 'history') return;
    setLoadError(null); setLoading(true);
    api.history().then(setHistory).catch(error => setLoadError(error.message)).finally(() => setLoading(false));
  }, [api, page]);
  const openHistory = async (id: string) => {
    setLoadError(null);
    try { controller.open(await api.session(id)); setPage('practice'); setReview(false); }
    catch (error) { setLoadError(error instanceof Error ? error.message : 'Could not open this session.'); }
  };
  const inRoom = state.phase === 'room' || review;
  return <div className={`app ${inRoom ? 'app-room' : ''}`}>
    <header className="site-header"><button className="wordmark" aria-label="Mockie home" onClick={() => { if (!inRoom) { controller.back(); setPage('practice'); } }}><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>mockie<span className="wordmark-period">.</span></button>
      {inRoom ? <span className="header-context"><Headphones size={16} /> A little space to think.</span> : <nav aria-label="Main navigation"><button className={page === 'practice' ? 'active' : ''} onClick={() => { controller.back(); setPage('practice'); }}><Code2 size={16} />Practice</button><button className={page === 'history' ? 'active' : ''} onClick={() => { controller.back(); setPage('history'); }}><History size={16} />History</button><button className={page === 'settings' ? 'active' : ''} onClick={() => { controller.back(); setPage('settings'); }}><Settings2 size={16} />Settings</button></nav>}
      <span className="local-label"><span />Your own interview room</span>
    </header>
    {loadError && <div role="alert" className="global-error">{loadError}<button onClick={() => { if (page === 'history') { setPage('practice'); void load(); } else void load(); }}>Try again</button></div>}
    {state.error && <div role="alert" className="global-error">{state.error}<button onClick={() => controller.dismissError()} aria-label="Dismiss error"><X size={16} /></button></div>}
    {inRoom ? <InterviewRoom controller={controller} review={review} onBack={() => { setReview(false); }} /> : state.phase === 'scorecard' ? <ScorecardView controller={controller} onReview={() => setReview(true)} onNew={() => { controller.back(); setPage('practice'); }} /> : page === 'history' ? <HistoryView sessions={history} loading={loading} onOpen={openHistory} onPractice={() => setPage('practice')} /> : page === 'settings' ? <SettingsView settings={settings} onSave={async next => { const saved = await api.saveSettings(next); setSettings(saved); }} /> : <Lobby problems={problems} settings={settings} loading={loading} starting={state.phase === 'starting'} onStart={options => controller.start(options)} />}
  </div>;
}

function Lobby({ problems, settings, loading, starting, onStart }: { problems: Problem[]; settings: Settings; loading: boolean; starting: boolean; onStart(options: { problemId?: string; customProblem?: string; language: Language; durationMinutes: number; mode: Mode }): Promise<void> }) {
  const [custom, setCustom] = useState(false);
  const [problemId, setProblemId] = useState('');
  const [customProblem, setCustomProblem] = useState('');
  const [language, setLanguage] = useState<Language>('python');
  const [duration, setDuration] = useState(45);
  const [mode, setMode] = useState<Mode>(settings.mode ?? 'offline');
  useEffect(() => setMode(settings.mode ?? 'offline'), [settings.mode]);
  useEffect(() => { if (typeof settings.defaultDurationMinutes === 'number') setDuration(settings.defaultDurationMinutes); }, [settings.defaultDurationMinutes]);
  const selected = problems.find(item => item.id === (problemId || problems[0]?.id));
  return <main className="lobby-main"><section className="lobby-intro"><p className="intro-kicker"><span className="quiet-line" />Practice, with presence.</p><h1>Find your<br />thinking space.</h1><p className="intro-description">A coding interview, at your pace. Talk through your ideas, try things out, and let a thoughtful interviewer follow along.</p>
    <div className="desk-preview" aria-hidden="true"><div className="preview-paper"><span className="preview-paper-line" /><span className="preview-paper-line short" /><div className="preview-code"><span /><span /><span /><span /></div></div><div className="preview-rail"><span className="status-indicator" />Listening <span className="preview-time">45:00</span></div><span className="preview-caption">Room for your next good idea.</span></div>
    <div className="lobby-footnote"><Headphones size={18} /><p>Think out loud. Your interviewer listens,<br />and speaks when it helps.</p></div>
  </section><section className="setup-panel" aria-labelledby="setup-title"><div className="setup-heading"><span className="room-number">The practice room</span><h2 id="setup-title">Make yourself comfortable.</h2><p>A few choices, then it's just you and the problem.</p></div>
    <form onSubmit={event => { event.preventDefault(); void onStart({ ...(custom ? { customProblem: customProblem.trim() } : { problemId: selected?.id }), language, durationMinutes: duration, mode }); }}>
      <fieldset className="problem-selector"><legend>Your problem</legend><div className="segmented-control"><button type="button" aria-pressed={!custom} className={!custom ? 'selected' : ''} onClick={() => setCustom(false)}>Choose a problem</button><button type="button" aria-pressed={custom} className={custom ? 'selected' : ''} onClick={() => setCustom(true)}>Paste a problem</button></div>
      {custom ? <label className="field">Custom problem<textarea rows={5} value={customProblem} onChange={event => setCustomProblem(event.target.value)} placeholder="Paste the problem statement, examples, and constraints…" required minLength={10} /></label> : <><label className="field" htmlFor="problem">Problem<select id="problem" value={selected?.id ?? ''} onChange={event => setProblemId(event.target.value)} required disabled={loading}><option value="" disabled>{loading ? 'Opening the problem book…' : 'Choose a problem'}</option>{problems.map(item => <option value={item.id} key={item.id}>{item.title}{item.difficulty ? ` / ${item.difficulty}` : ''}</option>)}</select></label>{selected && <p className="problem-hint"><FileText size={14} />{selected.description.slice(0, 125)}{selected.description.length > 125 ? '…' : ''}</p>}</>}
      </fieldset><div className="form-row"><label className="field" htmlFor="language">Language<select id="language" value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="python">Python 3</option><option value="javascript">JavaScript</option></select></label><label className="field" htmlFor="duration">Duration<select id="duration" value={duration} onChange={event => setDuration(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option><option value={90}>90 minutes</option></select></label></div>
      <fieldset className="mode-selector"><legend>Your interviewer</legend><label className={mode === 'offline' ? 'mode-option chosen' : 'mode-option'}><input type="radio" name="mode" checked={mode === 'offline'} onChange={() => setMode('offline')} /><span><strong>Offline practice</strong><small>A quiet, built-in practice partner. No model connection needed.</small></span></label><label className={mode === 'online' ? 'mode-option chosen' : 'mode-option'}><input type="radio" name="mode" checked={mode === 'online'} onChange={() => setMode('online')} /><span><strong>Connected interviewer</strong><small>Your configured model follows your thinking and code.</small></span></label></fieldset>
      <button className="primary start-button" disabled={starting || loading || (!custom && !selected)} type="submit">{starting ? 'Getting your room ready…' : 'Enter the room'}<ArrowRight size={18} /></button><p className="privacy-note">Your sessions stay on your server. Your pace stays yours.</p>
    </form></section><footer className="lobby-footer"><span>A little practice goes a long way.</span><span>Built for thinking, not performing.</span></footer></main>;
}

function InterviewRoom({ controller, review, onBack }: { controller: RoomController; review: boolean; onBack(): void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [voice] = useState(() => new SpeechController(browserSpeechEngine(), text => { void controller.send(text, 'voice'); }));
  useSyncExternalStore(voice.subscribe, voice.snapshot);
  const [draft, setDraft] = useState('');
  const [sidePanel, setSidePanel] = useState<'brief' | 'notes'>('brief');
  const [outputOpen, setOutputOpen] = useState(true);
  const lastSpoken = useRef<string | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const session = state.session!;
  useEffect(() => { if (!review) voice.listen(); return () => voice.dispose(); }, [voice, review]);
  useEffect(() => { if (state.ending) voice.mute(); }, [state.ending, voice]);
  useEffect(() => {
    const last = session.transcript.filter(entry => entry.role === 'interviewer').at(-1);
    if (!review && last && last.id !== lastSpoken.current) { lastSpoken.current = last.id; voice.say(last.text); }
    transcriptEnd.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }, [session.transcript, review, voice]);
  const voiceUnavailable = voice.state === 'unavailable' || voice.state === 'blocked';
  const railStatus = review ? 'Session complete' : voice.state === 'speaking' ? 'Speaking' : state.running ? 'Reviewing' : session.mode === 'offline' || state.status === 'offline' ? 'Offline practice' : voice.state === 'listening' ? 'Listening' : 'Ready when you are';
  return <main className={`interview-room side-${sidePanel}`}><div className="mobile-panel-tabs" role="group" aria-label="Room panels"><button aria-pressed={sidePanel === 'brief'} onClick={() => setSidePanel('brief')}><FileText size={15} />Problem brief</button><button aria-pressed={sidePanel === 'notes'} onClick={() => setSidePanel('notes')}><Headphones size={15} />Interview notes</button></div>
    <aside className="problem-panel"><div className="panel-label"><FileText size={16} />Problem brief<span className="difficulty">{session.problem.difficulty ?? 'Custom'}</span></div><div className="problem-content"><h1>{session.problem.title}</h1><p className="problem-description">{session.problem.description}</p>{session.problem.examples?.map((example, index) => <section className="example" key={index}><h2>Example {index + 1}</h2><dl><dt>Input</dt><dd><code>{example.input}</code></dd><dt>Output</dt><dd><code>{example.output}</code></dd></dl>{example.explanation && <p>{example.explanation}</p>}</section>)}{!!session.problem.constraints?.length && <section className="constraints"><h2>Keep in mind</h2><ul>{session.problem.constraints.map(item => <li key={item}><code>{item}</code></li>)}</ul></section>}<div className="brief-note"><span />There’s room to pause.<br />Talk through what you’re thinking.</div></div></aside>
    <section className="work-surface" aria-label="Coding workspace"><div className="workspace-topline"><span><Code2 size={15} />Your working space</span><span>{session.language === 'python' ? 'Python 3' : 'JavaScript'}<span className="saved-indicator">{state.saved ? <><Check size={12} />Saved</> : 'Saving…'}</span></span></div><CodeEditor code={state.code} language={session.language} readOnly={review || state.ending} onChange={code => controller.edit(code)} />
      <section className={`output-panel ${outputOpen ? 'expanded' : ''}`} aria-label="Run output"><div className="output-toolbar"><button className="output-toggle" onClick={() => setOutputOpen(!outputOpen)} aria-expanded={outputOpen}><Terminal size={15} />Run output<ChevronRight size={14} className={outputOpen ? 'rotate' : ''} /></button>{state.output && <span className={state.output.exitCode === 0 ? 'run-success' : 'run-failed'}>{state.output.timedOut ? 'Time limit reached' : state.output.exitCode === 0 ? 'Completed' : 'Execution failed'}{state.output.durationMs != null && ` / ${state.output.durationMs} ms`}</span>}<button className="run-button" aria-label="Run code" disabled={state.running || state.ending || review} onClick={() => { setOutputOpen(true); void controller.run(); }}><Play size={14} fill="currentColor" />{state.running ? 'Running…' : 'Run code'}</button></div>{outputOpen && <div className="output-content" tabIndex={0}>{state.output ? <><pre>{state.output.stdout || (!state.output.stderr ? 'Program finished with no output.' : '')}</pre>{state.output.stderr && <pre className="stderr">{state.output.stderr}</pre>}{state.output.truncated && <p className="output-warning">Output was truncated to keep the room responsive.</p>}</> : <p className="empty-output">A place to try things.<br /><span>Run your code to see the output here.</span></p>}</div>}</section>
    </section><aside className="notes-panel"><div className="panel-label"><Headphones size={16} />Interview notes<span className="notes-count">{session.transcript.length}</span></div><div className="notes-intro"><span className="interviewer-monogram">m.</span><div><strong>Your interviewer</strong><span>{review ? 'A record of your thinking.' : 'Here, and following along.'}</span></div><button className="icon-button" aria-label={voice.outputMuted ? 'Enable spoken replies' : 'Mute spoken replies'} title={voice.outputMuted ? 'Enable spoken replies' : 'Mute spoken replies'} onClick={() => voice.toggleOutput()}>{voice.outputMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button></div>
      <div className="transcript" role="log" aria-label="Interview transcript" aria-live="polite">{!session.transcript.length && <div className="transcript-empty"><span className="note-rule" /><p>Take a moment with the problem.</p><p>When you’re ready, share your first thoughts. Your interviewer will listen and leave notes here.</p></div>}{session.transcript.map(entry => <article key={entry.id} className={`transcript-entry ${entry.role}`}><div className="entry-meta"><span>{entry.role === 'candidate' ? 'You' : 'Interviewer'}</span><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{entry.text}</p></article>)}<div ref={transcriptEnd} /></div>
      {!review && <div className="conversation-controls">{voiceUnavailable && <p className="voice-fallback">{voice.state === 'blocked' ? 'Microphone access was blocked. Enable it in your browser, or type below.' : 'Voice recognition is unavailable in this browser. Type your thoughts below.'}</p>}<form className="message-form" onSubmit={async event => { event.preventDefault(); if (await controller.send(draft)) setDraft(''); }}><label className="sr-only" htmlFor="message">Message to interviewer</label><textarea id="message" rows={2} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Think out loud, or type here…" disabled={state.ending} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" aria-label="Send message" disabled={!draft.trim() || state.sending || state.ending}><Send size={17} /></button></form><div className="mic-line"><button className={`mic-control ${voice.state === 'listening' ? 'is-listening' : ''}`} onClick={() => { voice.state === 'listening' || voice.state === 'speaking' ? voice.mute() : voice.listen(); }} aria-label={voice.state === 'listening' ? 'Mute microphone' : 'Enable microphone'}>{voice.state === 'listening' ? <Mic size={15} /> : <MicOff size={15} />}{voice.state === 'listening' ? 'Mic on' : voice.state === 'speaking' ? 'Mic paused' : 'Mic off'}</button><span>{voice.state === 'speaking' ? 'Interviewer speaking' : 'Enter to send'}</span></div></div>}
    </aside><footer className={`room-rail ${voice.state === 'listening' || voice.state === 'speaking' || state.running ? 'signal' : ''}`}>
      <div className="rail-status"><span className="status-indicator" /><div><strong>{railStatus}</strong><span>{state.notice ?? (session.mode === 'offline' ? 'Your built-in practice partner is here.' : 'Your interviewer is quietly following along.')}</span></div></div>
      {!review && <div className="rail-quick-actions"><button aria-label="Run code from status rail" title="Run code" disabled={state.running || state.ending} onClick={() => { setOutputOpen(true); void controller.run(); }}><Play size={15} /></button><button aria-label="Toggle microphone from status rail" title={voice.state === 'listening' ? 'Mute microphone' : 'Enable microphone'} onClick={() => { voice.state === 'listening' || voice.state === 'speaking' ? voice.mute() : voice.listen(); }}>{voice.state === 'listening' ? <Mic size={15} /> : <MicOff size={15} />}</button></div>}
      <div className={`timer ${state.remainingSeconds <= 300 ? 'time-pressure' : ''}`}><Clock3 size={17} /><span aria-label="Time remaining" role="timer">{formatTime(state.remainingSeconds)}</span><small>remaining</small></div>
      {review ? <button className="end-button" onClick={onBack}><ArrowLeft size={15} />Back to scorecard</button> : <button className="end-button" disabled={state.ending || state.running} onClick={() => void controller.end()}><Square size={12} />{state.ending ? 'Reflecting…' : 'End interview'}</button>}
    </footer>
  </main>;
}

function ScorecardView({ controller, onNew, onReview }: { controller: RoomController; onNew(): void; onReview(): void }) {
  const { session, scorecard } = controller.state;
  return <main className="scorecard-page"><button className="text-button" onClick={onNew}><ArrowLeft size={15} />Back to practice</button><div className="reflection-heading"><span className="completion-mark"><Check size={24} /></span><p>Practice, reflected.</p><h1>A little reflection.</h1><p>{session?.problem.title} / {session?.language === 'python' ? 'Python 3' : 'JavaScript'} / {session?.durationMinutes} minutes</p></div>{scorecard ? <><p className="score-summary">{scorecard.summary}</p><div className="score-categories">{scorecard.categories.map(category => <section key={category.name}><div><h2>{category.name}</h2><span>{category.score}<small> / 5</small></span></div><div className="score-track"><span style={{ width: `${Math.max(0, Math.min(5, category.score)) * 20}%` }} /></div><p>{category.feedback}</p></section>)}</div><div className="reflection-columns"><section><h2>Carry this forward</h2><ul>{scorecard.strengths.map(item => <li key={item}>{item}</li>)}</ul></section><section><h2>Try next time</h2><ul>{scorecard.improvements.map(item => <li key={item}>{item}</li>)}</ul></section></div></> : <p className="score-summary">This session is saved. Review your code and interview notes below.</p>}<div className="score-actions"><button className="primary" onClick={onNew}>Another little practice<ArrowRight size={17} /></button><button className="secondary" onClick={onReview}>Review session</button></div><p className="score-footnote">Progress comes from showing up. See you in the room.</p></main>;
}

function HistoryView({ sessions, loading, onOpen, onPractice }: { sessions: Session[]; loading: boolean; onOpen(id: string): Promise<void>; onPractice(): void }) {
  return <main className="simple-page"><div className="page-intro"><p>Your practice, over time.</p><h1>The work adds up.</h1><span>Revisit a thought, a solution, or something to try next time.</span></div>{loading ? <p role="status">Opening your practice book…</p> : !sessions.length ? <div className="empty-history"><History size={30} /><h2>Your first page is waiting.</h2><p>Finished and in-progress interviews will live here.</p><button className="primary" onClick={onPractice}>Start practicing<ArrowRight size={17} /></button></div> : <div className="session-list">{sessions.map(session => <button className="session-row" key={session.id} aria-label={`Open ${session.problem.title}, ${date(session.startedAt)}`} onClick={() => void onOpen(session.id)}><span className="session-date">{date(session.startedAt)}</span><span className="session-info"><strong>{session.problem.title}</strong><small>{session.language === 'python' ? 'Python 3' : 'JavaScript'} / {session.durationMinutes} minutes / {session.mode === 'offline' ? 'Offline practice' : 'Connected interviewer'}</small></span><span className={`session-state ${session.status === 'ended' ? 'complete' : ''}`}>{session.status === 'ended' ? 'Complete' : 'In progress'}</span><ChevronRight size={19} /></button>)}</div>}</main>;
}

function SettingsView({ settings, onSave }: { settings: Settings; onSave(settings: Settings): Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <main className="simple-page settings-page"><div className="page-intro"><p>Make the room yours.</p><h1>A thoughtful setup.</h1><span>Choose the interviewer you want to practice with.</span></div><form onSubmit={async event => { event.preventDefault(); setSaving(true); setStatus(''); setError(''); try { await onSave(draft); setStatus('Settings saved. Your next interview will use this setup.'); } catch (error) { setError(error instanceof Error ? error.message : 'Settings could not be saved. Try again.'); } finally { setSaving(false); } }}><label className="field" htmlFor="default-mode">Default interviewer<select id="default-mode" value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as Mode })}><option value="offline">Offline practice</option><option value="online">Connected interviewer</option></select></label><label className="field" htmlFor="model">Model<input id="model" value={draft.model} required onChange={event => setDraft({ ...draft, model: event.target.value })} list="model-options" placeholder="chatgpt/gpt-5.4" /><datalist id="model-options"><option value="chatgpt/gpt-5.4" /><option value="chatgpt/gpt-5.4-mini" /><option value="offline" /></datalist></label><p className="field-help">Use a model available through your configured provider. Provider credentials are managed on your server.</p><div className="settings-note"><Headphones size={20} /><p>Voice uses your browser’s speech features. Microphone permission is requested when you enter a room. You can always type instead.</p></div><button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}<Check size={17} /></button>{status && <p role="status" className="save-status">{status}</p>}{error && <p role="alert" className="form-error">{error}</p>}</form></main>;
}
