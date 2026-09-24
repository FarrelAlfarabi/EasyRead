/**
 * Read aloud with the browser's built-in speech (Web Speech API), one sentence at a time so
 * the reader can highlight the sentence being spoken and keep it on screen.
 */
import { splitSentences } from './sentences';

export interface TtsPosition {
  block: number;
  start: number;
  end: number;
}

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null;
  const voices = speechSynthesis.getVoices();
  const l = lang.toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().startsWith(l) && v.localService) ?? voices.find((v) => v.lang.toLowerCase().startsWith(l)) ?? null;
}

/**
 * Speaks blocks from `from` onward. Calls `onSentence` before each sentence and `onEnd`
 * when the book (or `stop()`) ends it. `getText(i)` returns block text or null past the end.
 */
export class Speaker {
  private stopped = false;
  private paused = false;
  rate = 1;
  lang = 'en';
  private pos: TtsPosition | null = null;
  /** Bumped whenever speech is cancelled, so stale utterance callbacks are ignored. */
  private gen = 0;

  private getText: (block: number) => string | null;
  private onSentence: (p: TtsPosition) => void;
  private onEnd: () => void;

  constructor(getText: (block: number) => string | null, onSentence: (p: TtsPosition) => void, onEnd: () => void) {
    this.getText = getText;
    this.onSentence = onSentence;
    this.onEnd = onEnd;
  }

  get position() {
    return this.pos;
  }

  start(block: number, offset = 0) {
    if (!ttsSupported()) return;
    this.stopped = false;
    this.paused = false;
    this.gen++;
    speechSynthesis.cancel();
    this.speakFrom(block, offset);
  }

  private speakFrom(block: number, offset: number) {
    for (let b = block; ; b++) {
      const text = this.getText(b);
      if (text === null) {
        this.pos = null;
        this.onEnd();
        return;
      }
      const s = splitSentences(text).find((x) => x.end > offset);
      if (!s) {
        offset = 0;
        continue;
      }
      const start = Math.max(s.start, offset > s.start && offset < s.end ? offset : s.start);
      this.say(b, start, s.end, text);
      return;
    }
  }

  private say(block: number, start: number, end: number, text: string) {
    this.pos = { block, start, end };
    this.onSentence(this.pos);
    const gen = this.gen;
    const u = new SpeechSynthesisUtterance(text.slice(start, end));
    u.rate = this.rate;
    u.lang = this.lang;
    const v = pickVoice(this.lang);
    if (v) u.voice = v;
    u.onend = () => {
      if (gen !== this.gen || this.stopped || this.paused) return;
      this.speakFrom(block, end);
    };
    u.onerror = () => {
      if (gen !== this.gen || this.stopped || this.paused) return;
      this.speakFrom(block, end);
    };
    speechSynthesis.speak(u);
  }

  pause() {
    this.paused = true;
    this.gen++;
    speechSynthesis.cancel();
  }

  resume() {
    if (!this.pos) return;
    this.paused = false;
    this.speakFrom(this.pos.block, this.pos.start);
  }

  stop() {
    this.stopped = true;
    this.pos = null;
    this.gen++;
    if (ttsSupported()) speechSynthesis.cancel();
  }

  setRate(r: number) {
    this.rate = r;
    // Restart the current sentence at the new speed.
    if (this.pos && !this.paused && !this.stopped) {
      const p = this.pos;
      this.gen++;
      speechSynthesis.cancel();
      this.speakFrom(p.block, p.start);
    }
  }
}
