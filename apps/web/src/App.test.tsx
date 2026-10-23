import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppApi, Session } from './lib/types';

const problem = { id: 'two-sum', title: 'Two sum', difficulty: 'Easy', description: 'Given an array of integers, return the indices of two numbers that add up to target.', starterCode: { python: 'def two_sum(nums, target):\n    pass', javascript: 'function twoSum(nums, target) {\n}' }, examples: [{ input: '[2, 7, 11, 15], 9', output: '[0, 1]' }] };
const scorecard = { summary: 'Your reasoning was clear. Keep exploring edge cases.', overall: 4, categories: [{ name: 'Communication', score: 4, feedback: 'Clear reasoning.' }], strengths: ['Clear reasoning'], improvements: ['Test empty inputs'] };
function fixture() {
  const session: Session = { id: 's1', problem, language: 'python', durationMinutes: 45, mode: 'offline', code: problem.starterCode.python, status: 'active', startedAt: new Date().toISOString(), transcript: [], runs: [] };
  const messages: string[] = [];
  const api: AppApi = {
    problems: async () => [problem], settings: async () => ({ mode: 'offline', model: 'offline' }), saveSettings: async settings => settings,
    history: async () => [{ ...session, status: 'ended', scorecard }], session: async () => ({ ...session, status: 'ended', scorecard }),
    start: vi.fn(async options => ({ ...session, language: options.language, mode: options.mode, durationMinutes: options.durationMinutes })),
    updateCode: async () => {}, message: async (_id, text) => { messages.push(text); },
    run: async () => ({ id: 'r1', stdout: 'answer: 42', stderr: '', exitCode: 0, durationMs: 12 }), end: async () => scorecard,
    subscribe: () => () => {}
  };
  return { api, messages };
}
describe('primary interview flow', () => {
  it('starts a configured interview, accepts typed speech fallback, shows output, and ends with a scorecard', async () => {
    const { api, messages } = fixture();
    render(<App api={api} />);
    await screen.findByRole('option', { name: /Two sum/ });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'javascript' } });
    fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter the room' }));
    expect(await screen.findByRole('heading', { name: 'Two sum' })).toBeInTheDocument();
    expect(screen.getByLabelText('Time remaining')).toHaveTextContent('30:00');
    expect(screen.getByText(/Voice recognition is unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message to interviewer'), { target: { value: 'Can the array be empty?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(messages).toEqual(['Can the array be empty?']));
    expect(await screen.findByText('Can the array be empty?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run code' }));
    expect(await screen.findByText('answer: 42')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'End interview' }));
    expect(await screen.findByRole('heading', { name: 'A little reflection.' })).toBeInTheDocument();
    expect(screen.getByText('Test empty inputs')).toBeInTheDocument();
  });
  it('reopens a saved session from history', async () => {
    const { api } = fixture();
    render(<App api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const row = await screen.findByRole('button', { name: /Open Two sum/ });
    fireEvent.click(row);
    expect(await screen.findByText(scorecard.summary)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review session' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review session' }));
    expect(screen.getByLabelText('Code editor')).toHaveValue(problem.starterCode.python);
  });
  it('lets custom prompts enter the room and saves model settings', async () => {
    const { api } = fixture();
    const settings: unknown[] = [];
    api.saveSettings = async value => { settings.push(value); return value; };
    render(<App api={api} />);
    await screen.findByRole('option', { name: /Two sum/ });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'chatgpt/gpt-5.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved');
    expect(settings).toContainEqual(expect.objectContaining({ model: 'chatgpt/gpt-5.4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paste a problem' }));
    fireEvent.change(screen.getByLabelText('Custom problem'), { target: { value: 'Write a function to count unique words.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter the room' }));
    await screen.findByRole('heading', { name: 'Two sum' });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ customProblem: 'Write a function to count unique words.' }));
  });
  it('shows retry guidance when loading fails', async () => {
    const { api } = fixture();
    api.problems = async () => { throw new Error('Server unavailable'); };
    render(<App api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
  it('keeps run and microphone actions available from the mobile status rail', async () => {
    const { api } = fixture();
    render(<App api={api} />);
    await screen.findByRole('option', { name: /Two sum/ });
    fireEvent.click(screen.getByRole('button', { name: 'Enter the room' }));
    await screen.findByRole('heading', { name: 'Two sum' });
    fireEvent.click(screen.getByRole('button', { name: 'Run code from status rail' }));
    expect(await screen.findByText('answer: 42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle microphone from status rail' })).toBeInTheDocument();
  });
  it('applies the saved default interview duration', async () => {
    const { api } = fixture();
    api.settings = async () => ({ mode: 'offline', model: 'offline', defaultDurationMinutes: 30 });
    render(<App api={api} />);
    await screen.findByRole('option', { name: /Two sum/ });
    await waitFor(() => expect(screen.getByLabelText('Duration')).toHaveValue('30'));
  });
});
