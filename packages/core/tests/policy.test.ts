import { describe, expect, it } from 'vitest';
import { createPolicyState, decideNextAction } from '../src/index.js';

describe('deterministic speaking policy', () => {
  it('responds to a direct candidate message even during automatic cooldown', () => {
    const state = { ...createPolicyState(0, 45 * 60_000), lastAutomaticSpeechAt: 10_000 };
    expect(decideNextAction(state, { type: 'candidate_message', text: 'Can I assume sorted input?' }, 10_500))
      .toMatchObject({ action: 'respond', reason: 'direct_message', state: { lastActivityAt: 10_500 } });
  });

  it('stays quiet while the candidate is actively editing and considers once after seven seconds', () => {
    const first = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'code_changed', revision: 1 }, 5_000);
    expect(first.action).toBe('silent');
    const next = decideNextAction(first.state, { type: 'code_changed', revision: 2 }, 10_000);
    expect(decideNextAction(next.state, { type: 'tick' }, 16_999).action).toBe('silent');
    const pause = decideNextAction(next.state, { type: 'tick' }, 17_000);
    expect(pause).toMatchObject({ action: 'consider', reason: 'post_edit_pause' });
    expect(decideNextAction(pause.state, { type: 'tick' }, 17_001).action).toBe('silent');
  });

  it('ignores duplicate and reordered code revisions without resetting a meaningful pause', () => {
    const edited = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'code_changed', revision: 2 }, 1_000);
    const duplicate = decideNextAction(edited.state, { type: 'code_changed', revision: 2 }, 4_000);
    const reordered = decideNextAction(duplicate.state, { type: 'code_changed', revision: 1 }, 5_000);
    expect(reordered.state.lastMeaningfulEditAt).toBe(1_000);
    expect(reordered.state.lastActivityAt).toBe(1_000);
    expect(decideNextAction(reordered.state, { type: 'tick' }, 8_000).reason).toBe('post_edit_pause');
  });

  it('considers extended idle at seventy-five seconds and does not repeat on every tick', () => {
    const state = createPolicyState(0, 45 * 60_000);
    expect(decideNextAction(state, { type: 'tick' }, 74_999).action).toBe('silent');
    const idle = decideNextAction(state, { type: 'tick' }, 75_000);
    expect(idle).toMatchObject({ action: 'consider', reason: 'extended_idle' });
    expect(decideNextAction(idle.state, { type: 'tick' }, 75_001).action).toBe('silent');
    expect(decideNextAction(idle.state, { type: 'tick' }, 150_000).reason).toBe('extended_idle');
  });

  it('defers automatic consideration until the sixty-second speech cooldown has elapsed', () => {
    const state = { ...createPolicyState(0, 45 * 60_000), lastMeaningfulEditAt: 1_000, codeRevision: 1, lastAutomaticSpeechAt: 5_000 };
    expect(decideNextAction(state, { type: 'tick' }, 64_999).action).toBe('silent');
    expect(decideNextAction(state, { type: 'tick' }, 65_000)).toMatchObject({ action: 'consider', reason: 'post_edit_pause' });
  });

  it('considers each completed run once without interrupting subsequent typing', () => {
    const run = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'run_completed', jobId: 'job-1' }, 5_000);
    expect(run).toMatchObject({ action: 'consider', reason: 'run_completed' });
    expect(decideNextAction(run.state, { type: 'run_completed', jobId: 'job-1' }, 6_000).action).toBe('silent');
    const edit = decideNextAction(run.state, { type: 'code_changed', revision: 1 }, 7_000);
    expect(decideNextAction(edit.state, { type: 'tick' }, 8_000).action).toBe('silent');
  });

  it('defers a completed run during active typing then considers it once after the quiet period', () => {
    const edit = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'code_changed', revision: 1 }, 5_000);
    const run = decideNextAction(edit.state, { type: 'run_completed', jobId: 'job-1' }, 6_000);
    expect(run.action).toBe('silent');
    const considered = decideNextAction(run.state, { type: 'tick' }, 12_000);
    expect(considered).toMatchObject({ action: 'consider', reason: 'run_completed' });
    expect(decideNextAction(considered.state, { type: 'run_completed', jobId: 'job-1' }, 13_000).action).toBe('silent');
  });

  it('starts cooldown only when automatic speech actually occurs', () => {
    const considered = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'tick' }, 75_000);
    const spoken = decideNextAction(considered.state, { type: 'automatic_speech' }, 76_000);
    const run = decideNextAction(spoken.state, { type: 'run_completed', jobId: 'job-1' }, 80_000);
    expect(run).toMatchObject({ action: 'silent', reason: 'cooldown' });
    expect(decideNextAction(run.state, { type: 'tick' }, 136_000)).toMatchObject({ action: 'consider', reason: 'run_completed' });
  });

  it('keeps terminal sessions silent even for direct questions', () => {
    const ended = decideNextAction(createPolicyState(0, 45 * 60_000), { type: 'ended' }, 2_000);
    expect(decideNextAction(ended.state, { type: 'candidate_message', text: 'Hello?' }, 3_000))
      .toMatchObject({ action: 'silent', reason: 'terminal' });
  });

  it('considers a time checkpoint only once while respecting active editing', () => {
    const state = createPolicyState(0, 600_000);
    const edit = decideNextAction(state, { type: 'code_changed', revision: 1 }, 299_000);
    expect(decideNextAction(edit.state, { type: 'tick' }, 300_000).action).toBe('silent');
    const pause = decideNextAction(edit.state, { type: 'tick' }, 306_000);
    const checkpoint = decideNextAction(pause.state, { type: 'tick' }, 306_001);
    expect(checkpoint).toMatchObject({ action: 'consider', reason: 'time_checkpoint' });
    expect(decideNextAction(checkpoint.state, { type: 'tick' }, 306_002).reason).not.toBe('time_checkpoint');
  });
});
