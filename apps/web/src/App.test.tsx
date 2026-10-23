import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppApi, Scorecard, Session } from './lib/types';

const problem = { id: 'two-sum', title: 'Two sum', difficulty: 'Easy', description: 'Given an array of integers, return the indices of two numbers that add up to target.', starterCode: { python: 'def two_sum(nums, target):\n    pass', javascript: 'function twoSum(nums, target) {\n}' }, examples: [{ input: '[2, 7, 11, 15], 9', output: '[0, 1]' }] };
const scorecard = { summary: 'Your reasoning was clear. Keep exploring edge cases.', overall: 4, categories: [{ name: 'Communication', score: 4, feedback: 'Clear reasoning.' }], strengths: ['Clear reasoning'], improvements: ['Test empty inputs'] };
function fixture(savedScorecard: Scorecard = scorecard) {
  const session: Session = { id: 's1', problem, language: 'python', durationMinutes: 45, mode: 'offline', code: problem.starterCode.python, status: 'active', startedAt: new Date().toISOString(), transcript: [], runs: [] };
  const messages: string[] = [];
  const api: AppApi = {
    problems: async () => [problem], settings: async () => ({ mode: 'offline', model: 'offline' }), saveSettings: async settings => settings,
    history: async () => [{ ...session, status: 'ended', scorecard: savedScorecard }], session: async () => ({ ...session, status: 'ended', scorecard: savedScorecard }),
    start: vi.fn(async options => ({ ...session, language: options.language, mode: options.mode, durationMinutes: options.durationMinutes })),
    updateCode: async () => {}, message: async (_id, text) => { messages.push(text); },
    run: async () => ({ id: 'r1', stdout: 'answer: 42', stderr: '', exitCode: 0, durationMs: 12 }), end: async () => savedScorecard,
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
    expect(screen.getByText('Earlier scorecard (unversioned)')).toBeInTheDocument();
    const communication = screen.getByRole('heading', { name: 'Communication' }).closest('section')!;
    expect(communication).toHaveTextContent('4 / 5');
    expect(screen.queryByText(/Senior SWE coding rubric/)).not.toBeInTheDocument();
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

describe('evidence-based scorecard', () => {
  async function openSaved(card: Scorecard) {
    const { api } = fixture(card);
    render(<App api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open Two sum/ }));
    await screen.findByRole('heading', { name: 'A little reflection.' });
  }

  it('shows an unassessed category without inventing a zero or a score bar', async () => {
    await openSaved({ ...scorecard, source: 'model', rubricVersion: 'senior-swe-v1', categories: [
      { name: 'Complexity', score: null, feedback: 'Complexity was not discussed.', assistance: 'not_observed', evidence: [] }
    ] });
    const category = within(screen.getByRole('group', { name: 'Category scores' })).getByRole('heading', { name: 'Complexity' }).closest('section')!;
    expect(within(category).getByText('Not assessed')).toBeInTheDocument();
    expect(category).not.toHaveTextContent('/ 5');
    expect(category).not.toHaveTextContent('0');
    expect(within(category).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('explains a versioned model score with assistance, source quotes and an expandable rubric', async () => {
    await openSaved({ ...scorecard, source: 'model', rubricVersion: 'senior-swe-v1', categories: [
      { name: 'Communication', score: 3, feedback: 'Explained the constraint after a neutral prompt.', assistance: 'prompted', evidence: [{ source: 'transcript', id: 'private-turn-id', quote: 'The input order matters.' }] },
      { name: 'Testing', score: 2, feedback: 'Added a duplicate test with substantial help.', assistance: 'guided', evidence: [{ source: 'run', id: 'private-run-id', quote: '[0, 1]' }] },
      { name: 'Coding', score: 4, feedback: 'Used clear names independently.', assistance: 'independent', evidence: [{ source: 'code', quote: 'seen_indices = {}' }] }
    ] });
    expect(screen.getByText(/Senior SWE coding rubric.*senior-swe-v1/)).toBeInTheDocument();
    expect(screen.getByText(/Model assessment/)).toBeInTheDocument();
    expect(screen.getByText('Neutral prompts')).toBeInTheDocument();
    expect(screen.getByText('Substantial guidance')).toBeInTheDocument();
    expect(screen.getByText('Independent')).toBeInTheDocument();
    const communication = within(screen.getByRole('group', { name: 'Category scores' })).getByRole('heading', { name: 'Communication' }).closest('section')!;
    expect(within(communication).getByRole('meter')).toHaveAttribute('aria-valuenow', '3');
    expect(within(communication).getByText('Transcript')).toBeInTheDocument();
    expect(within(communication).getByText('The input order matters.')).toBeInTheDocument();
    expect(screen.getByText('[0, 1]')).toBeInTheDocument();
    expect(screen.getByText('seen_indices = {}')).toBeInTheDocument();
    expect(screen.queryByText(/private-turn-id|private-run-id/)).not.toBeInTheDocument();
    const guideToggle = screen.getByText('How scores are assessed');
    const guide = guideToggle.closest('details')!;
    expect(guide).not.toHaveAttribute('open');
    fireEvent.click(guideToggle);
    expect(guide).toHaveAttribute('open');
    for (const name of ['Communication', 'Problem solving', 'Coding', 'Testing', 'Complexity']) {
      expect(within(guide).getByRole('heading', { name })).toBeInTheDocument();
    }
    for (const label of ['Significant gaps', 'Developing', 'Meets expectations', 'Strong', 'Exceptional']) {
      expect(within(guide).getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['offline', /Scripted offline practice.*no competence grades/i],
    ['fallback', /Model assessment was unavailable.*no competence grades/i]
  ] as const)('identifies %s scorecards so a local summary is not mistaken for a model grade', async (source, caveat) => {
    await openSaved({ ...scorecard, source, rubricVersion: 'senior-swe-v1', categories: [
      { name: 'Communication', score: null, feedback: 'Review your saved conversation.', assistance: 'not_observed', evidence: [] }
    ] });
    expect(screen.getByText(caveat)).toBeInTheDocument();
    expect(screen.getByText('Not assessed')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
});
