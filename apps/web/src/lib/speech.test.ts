import { describe, expect, it } from 'vitest';
import { SpeechController } from './speech';

function fixture() {
  let onResult: (text: string) => void = () => {};
  let onEnd: () => void = () => {};
  let done: () => void = () => {};
  const calls: string[] = [];
  const words: string[] = [];
  const engine = { available: true, start: (result: typeof onResult, end: typeof onEnd) => { calls.push('start'); onResult = result; onEnd = end; }, stop: () => { calls.push('stop'); }, speak: (_text: string, end: () => void) => { calls.push('speak'); done = end; }, cancel: () => { calls.push('cancel'); } };
  const voice = new SpeechController(engine, text => words.push(text));
  return { voice, calls, words, result: (text: string) => onResult(text), ended: () => onEnd(), done: () => done() };
}
describe('voice lifecycle', () => {
  it('restarts always-on recognition after a browser end event', () => {
    const { voice, calls } = fixture();
    voice.listen();
    expect(voice.state).toBe('listening');
    voice.recognitionEnded();
    expect(calls).toEqual(['start', 'start']);
    voice.dispose();
  });
  it('pauses recognition during speech, ignores echo, and resumes afterward', () => {
    const { voice, calls, result, done, words } = fixture();
    voice.listen();
    voice.say('What is the time complexity?');
    expect(voice.state).toBe('speaking');
    result('What is the time complexity?');
    expect(words).toEqual([]);
    done();
    expect(voice.state).toBe('listening');
    expect(calls).toEqual(['start', 'stop', 'speak', 'start']);
    result('Linear time.');
    expect(words).toEqual(['Linear time.']);
    voice.dispose();
  });
  it('keeps an explicit mic mute in effect after synthesis ends', () => {
    const { voice, done } = fixture();
    voice.listen();
    voice.say('Hello');
    voice.mute();
    done();
    expect(voice.state).toBe('muted');
    voice.dispose();
  });
  it('offers typed fallback when recognition is unavailable', () => {
    const voice = new SpeechController({ available: false, start() {}, stop() {}, speak(_text, end) { end(); }, cancel() {} }, () => {});
    voice.listen();
    expect(voice.state).toBe('unavailable');
    voice.dispose();
  });
  it('does not resume listening when an old speech completion arrives during a newer reply', () => {
    const completions: Array<() => void> = [];
    const voice = new SpeechController({ available: true, start() {}, stop() {}, speak(_text, end) { completions.push(end); }, cancel() {} }, () => {});
    voice.listen();
    voice.say('First reply');
    voice.say('Second reply');
    completions[0]();
    expect(voice.state).toBe('speaking');
    completions[1]();
    expect(voice.state).toBe('listening');
    voice.dispose();
  });
});
