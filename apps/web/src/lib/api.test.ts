import { describe, expect, it, vi } from 'vitest';
import { createApi } from './api';

describe('server boundary', () => {
  it('adapts wrapped sessions and sends versioned code changes to the event endpoint', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      return new Response(JSON.stringify(url.endsWith('/events') ? { accepted: true } : { session: { id: 's1', problem: { id: 'custom', title: 'Custom', description: 'Do a thing', starterCode: { python: 'pass', javascript: '' } }, language: 'python', durationMinutes: 45, mode: 'offline', code: 'pass', status: 'active', startedAt: new Date().toISOString() } }), { status: 200 });
    });
    const api = createApi(fetcher as typeof fetch);
    const session = await api.start({ problemId: 'two-sum', language: 'python', durationMinutes: 45, mode: 'offline' });
    expect(session.transcript).toEqual([]);
    await api.updateCode('s1', 'print(42)', 2);
    expect(requests.at(-1)).toEqual({ url: '/api/sessions/s1/events', body: { type: 'code_change', code: 'print(42)', revision: 2 } });
  });
  it('turns a structured server failure into a useful recoverable error', async () => {
    const api = createApi(async () => new Response(JSON.stringify({ error: 'Runner is unavailable' }), { status: 503 }));
    await expect(api.run('s1', 'pass', 'python')).rejects.toThrow('Runner is unavailable');
  });
  it('omits a JSON content type on the bodyless end request so Fastify accepts it', async () => {
    const fetcher: typeof fetch = async (_input, options) => {
      if (new Headers(options?.headers).has('Content-Type') && !options?.body) return new Response(JSON.stringify({ error: 'Body cannot be empty when content-type is application/json' }), { status: 400 });
      return new Response(JSON.stringify({ scorecard: { summary: 'Saved', categories: [], strengths: [], improvements: [] } }));
    };
    const api = createApi(fetcher);
    expect((await api.end('s1')).summary).toBe('Saved');
  });
  it('normalizes core provider, transcript, and score category contracts and posts custom prompts as objects', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = String(input); requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      const raw = { id: 's2', providerMode: 'online', problem: { id: 'custom', title: 'Words', description: 'Count words.', starterCode: { python: 'pass', javascript: '' } }, transcript: [{ id: 't1', role: 'interviewer', text: 'Hello', createdAt: '2026-10-22T10:00:00.000Z' }], runs: [], scorecard: { summary: 'Keep going', categories: [{ key: 'problem_solving', score: 3, feedback: 'Explore' }], strengths: [], improvements: [] } };
      const data = url.endsWith('/settings') ? { providerMode: 'online', model: 'chatgpt/test', autoListen: true } : { session: raw, scorecard: raw.scorecard };
      return new Response(JSON.stringify(data));
    };
    const api = createApi(fetcher);
    const session = await api.start({ customProblem: 'Count unique words.', language: 'python', durationMinutes: 45, mode: 'online' });
    expect(requests[0].body.customProblem).toEqual({ title: 'Custom problem', description: 'Count unique words.' });
    expect(session.mode).toBe('online');
    expect(session.transcript[0].at).toBe('2026-10-22T10:00:00.000Z');
    expect(session.scorecard?.categories[0].name).toBe('Problem solving');
    const settings = await api.settings();
    expect(settings.mode).toBe('online');
    await api.saveSettings({ ...settings, mode: 'offline' });
    expect(requests.at(-1)?.body).toEqual({ providerMode: 'offline', model: 'chatgpt/test', autoListen: true });
  });
});
