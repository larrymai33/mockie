import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomController } from './room';

const session = { id: 's1', problem: { id: 'two-sum', title: 'Two sum', description: 'Return two indices.', difficulty: 'Easy', starterCode: { python: 'def two_sum(nums, target):\n    pass', javascript: 'function twoSum(nums, target) {\n}' } }, language: 'python', durationMinutes: 45, mode: 'offline', code: 'pass', status: 'active', startedAt: new Date().toISOString(), transcript: [], runs: [] } as const;
function fixture() {
  const events: unknown[] = [];
  let receive: (event: unknown) => void = () => {};
  const api = {
    start: vi.fn(async () => structuredClone(session)),
    updateCode: vi.fn(async (_id: string, code: string) => { events.push({ code }); }),
    message: vi.fn(async (_id: string, text: string) => { events.push({ text }); }),
    run: vi.fn(async () => ({ id: 'r1', stdout: '42\n', stderr: '', exitCode: 0, durationMs: 4 })),
    end: vi.fn(async () => ({ summary: 'A useful first session.', overall: 3, categories: [{ name: 'Communication', score: 3, feedback: 'Explain your choices.' }], strengths: ['Clear approach'], improvements: ['Check edge cases'] })),
    subscribe: vi.fn((_id: string, handler: (event: unknown) => void) => { receive = handler; return () => {}; })
  };
  const controller = new RoomController(api as never);
  return { controller, api, events, receive: (event: unknown) => receive(event) };
}
afterEach(() => vi.useRealTimers());

describe('room lifecycle', () => {
  it('opens a selected offline interview and preserves its duration', async () => {
    const { controller } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    expect(controller.state.session?.id).toBe('s1');
    expect(controller.state.phase).toBe('room');
    expect(controller.state.remainingSeconds).toBe(2700);
    controller.dispose();
  });
  it('sends only the latest edit after 750 milliseconds', async () => {
    vi.useFakeTimers();
    const { controller, events } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    controller.edit('first');
    await vi.advanceTimersByTimeAsync(400);
    controller.edit('print(42)');
    await vi.advanceTimersByTimeAsync(749);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([{ code: 'print(42)' }]);
    controller.dispose();
  });
  it('keeps failed runs recoverable and displays the next successful output', async () => {
    const { controller, api } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    api.run.mockRejectedValueOnce(new Error('Runner unavailable'));
    await controller.run();
    expect(controller.state.error).toContain('Runner unavailable');
    expect(controller.state.phase).toBe('room');
    await controller.run();
    expect(controller.state.output?.stdout).toBe('42\n');
    expect(controller.state.error).toBeNull();
    controller.dispose();
  });
  it('accepts typed questions and nonfatal provider events without ending', async () => {
    const { controller, events, receive } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    await controller.send('Could the input be empty?');
    expect(events).toContainEqual({ text: 'Could the input be empty?' });
    expect(controller.state.session?.transcript.at(-1)?.text).toBe('Could the input be empty?');
    receive({ type: 'status', status: 'offline', message: 'Provider unavailable. Continue coding.' });
    expect(controller.state.phase).toBe('room');
    expect(controller.state.notice).toContain('Provider unavailable');
    controller.dispose();
  });
  it('flushes pending code before ending and freezes the scorecard timer', async () => {
    vi.useFakeTimers();
    const { controller, events } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    controller.edit('final code');
    await controller.end();
    const frozen = controller.state.remainingSeconds;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual([{ code: 'final code' }]);
    expect(controller.state.phase).toBe('scorecard');
    expect(controller.state.scorecard?.summary).toBe('A useful first session.');
    expect(controller.state.remainingSeconds).toBe(frozen);
    controller.dispose();
  });
  it('blocks new voice or typed messages as soon as ending begins', async () => {
    const { controller, api } = fixture();
    let release!: (value: Awaited<ReturnType<typeof api.end>>) => void;
    api.end.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });

    const ending = controller.end();
    expect(await controller.send('Spoken after End', 'voice')).toBe(false);
    expect(api.message).not.toHaveBeenCalled();
    release({ summary: 'Done.', overall: 3, categories: [], strengths: [], improvements: [] });
    await ending;
    controller.dispose();
  });
  it('accepts an ended session broadcast when the end response is lost', async () => {
    const { controller, api, receive } = fixture();
    let rejectEnd: (reason: Error) => void = () => {};
    api.end.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnd = reject; }));
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });

    const ending = controller.end();
    await Promise.resolve();
    const scorecard = { summary: 'Saved on the server.', overall: 4, categories: [], strengths: [], improvements: [] };
    receive({ type: 'session', session: { ...session, status: 'ended', endedAt: new Date().toISOString(), scorecard } });
    rejectEnd(new Error('connection lost'));
    await ending;

    expect(controller.state.phase).toBe('scorecard');
    expect(controller.state.session?.status).toBe('ended');
    expect(controller.state.scorecard).toEqual(scorecard);
    expect(controller.state.error).toBeNull();
    controller.dispose();
  });
  it('renders persisted payload events and provider errors without losing the working code', async () => {
    const { controller, receive } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    controller.edit('unsaved work');
    receive({ type: 'event', event: { id: 'e1', type: 'interviewer_message', payload: { text: 'What about duplicates?' }, createdAt: new Date().toISOString() } });
    expect(controller.state.session?.transcript.at(-1)?.text).toBe('What about duplicates?');
    receive({ type: 'event', event: { type: 'system_status', payload: { recoverable: true, message: 'Model unavailable' } } });
    expect(controller.state.notice).toBe('Model unavailable');
    expect(controller.state.code).toBe('unsaved work');
    controller.dispose();
  });
  it('reconciles a socket session snapshot without replacing locally edited code', async () => {
    const { controller, receive } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    controller.edit('my latest edit');
    receive({ type: 'session', session: { ...session, code: 'older saved code', transcript: [{ id: 'reply', role: 'interviewer', text: 'Consider a map.', at: new Date().toISOString() }] } });
    expect(controller.state.code).toBe('my latest edit');
    expect(controller.state.session?.transcript[0].text).toBe('Consider a map.');
    controller.dispose();
  });
  it('recovers a failed debounced save without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const { controller, api } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    api.updateCode.mockRejectedValueOnce(new Error('Connection lost'));
    controller.edit('still here');
    await vi.advanceTimersByTimeAsync(750);
    expect(controller.state.error).toContain('Connection lost');
    expect(controller.state.code).toBe('still here');
    await controller.flush();
    expect(controller.state.saved).toBe(true);
    controller.dispose();
  });
  it('does not discard a newer transcript entry when a reconnect snapshot arrives late', async () => {
    const { controller, receive } = fixture();
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    receive({ type: 'event', event: { id: 'new-reply', type: 'interviewer_message', payload: { text: 'Try a small example.' } } });
    receive({ type: 'session', session: { ...session, transcript: [] } });
    expect(controller.state.session?.transcript.map(item => item.text)).toEqual(['Try a small example.']);
    controller.dispose();
  });
  it('freezes the clock while a scorecard is being generated', async () => {
    vi.useFakeTimers();
    const { controller, api } = fixture();
    let complete: (value: Awaited<ReturnType<typeof api.end>>) => void = () => {};
    api.end.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await controller.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    const ending = controller.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.state.remainingSeconds).toBe(2700);
    complete({ summary: 'Saved', overall: 3, categories: [], strengths: [], improvements: [] });
    await ending;
    controller.dispose();
  });
});
