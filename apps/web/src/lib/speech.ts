export type VoiceState = 'listening' | 'speaking' | 'muted' | 'unavailable' | 'blocked';
export interface SpeechEngine {
  available: boolean;
  start(onResult: (text: string) => void, onEnd: () => void, onError?: (error: string) => void): void;
  stop(): void;
  speak(text: string, onEnd: () => void): void;
  cancel(): void;
}
export class SpeechController {
  state: VoiceState = 'muted';
  outputMuted = false;
  private enabled = false;
  private speaking = false;
  private disposed = false;
  private utterance = 0;
  private listeners = new Set<() => void>();
  constructor(private engine: SpeechEngine, private onText: (text: string) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => `${this.state}:${this.outputMuted}`;
  private set(state: VoiceState) { this.state = state; this.listeners.forEach(listener => listener()); }
  listen() { this.enabled = true; this.start(); }
  private start() {
    if (this.disposed || !this.enabled || this.speaking) return;
    if (!this.engine.available) { this.set('unavailable'); return; }
    this.set('listening');
    this.engine.start(text => { if (this.enabled && !this.speaking && this.state === 'listening' && text.trim()) this.onText(text.trim()); }, () => this.recognitionEnded(), error => { this.enabled = false; this.set(error === 'not-allowed' || error === 'service-not-allowed' ? 'blocked' : 'unavailable'); });
  }
  recognitionEnded() { if (this.enabled && !this.speaking && this.state === 'listening') this.start(); }
  mute() { this.enabled = false; this.set('muted'); this.engine.stop(); }
  toggleOutput() { this.outputMuted = !this.outputMuted; if (this.outputMuted && this.speaking) { this.engine.cancel(); this.speaking = false; this.enabled ? this.start() : this.set('muted'); } this.listeners.forEach(listener => listener()); }
  say(text: string) {
    if (this.disposed || this.outputMuted || !text.trim()) return;
    const utterance = ++this.utterance;
    if (this.speaking) this.engine.cancel();
    this.speaking = true;
    this.set('speaking');
    this.engine.stop();
    this.engine.speak(text, () => { if (utterance !== this.utterance) return; this.speaking = false; if (!this.disposed) this.enabled ? this.start() : this.set('muted'); });
  }
  dispose() { this.disposed = true; this.enabled = false; this.engine.stop(); this.engine.cancel(); this.listeners.clear(); }
}

// Vendor Web Speech APIs are isolated here; the controller is tested with a fake engine.
export function browserSpeechEngine(): SpeechEngine {
  type Recognition = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null; start(): void; abort(): void };
  const host = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  let recognition: Recognition | undefined;
  let restarting: ReturnType<typeof setTimeout> | undefined;
  return {
    available: !!Constructor,
    start(result, end, error) {
      if (!Constructor) return;
      clearTimeout(restarting);
      restarting = setTimeout(() => {
        recognition = new Constructor();
        recognition.continuous = true; recognition.interimResults = false; recognition.lang = 'en-US';
        recognition.onresult = event => { for (let index = event.resultIndex; index < event.results.length; index++) { const item = event.results[index]; if (item.isFinal) result(item[0].transcript); } };
        recognition.onend = end; recognition.onerror = event => { if (event.error !== 'no-speech' && event.error !== 'aborted') error?.(event.error); };
        try { recognition.start(); } catch { error?.('unavailable'); }
      }, 150);
    },
    stop() { clearTimeout(restarting); if (recognition) { recognition.onend = null; recognition.onresult = null; recognition.abort(); recognition = undefined; } },
    speak(text, end) { if (!window.speechSynthesis) { end(); return; } const utterance = new SpeechSynthesisUtterance(text); utterance.rate = 0.97; utterance.onend = end; utterance.onerror = end; window.speechSynthesis.speak(utterance); },
    cancel() { window.speechSynthesis?.cancel(); }
  };
}
