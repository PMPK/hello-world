/**
 * Procedural ambient score. Slow pad chords drift through a modal
 * progression with the odd soft plucked note on the strategic map; on the
 * battlefield the harmony darkens and a low pulse takes over. Everything is
 * scheduled a little ahead on the AudioContext clock from a light timer, so
 * it costs a handful of oscillators at a time.
 *
 * Presentation only; cosmetic randomness (Math.random) is fine here.
 */

export type MusicMode = 'calm' | 'battle' | 'off';

/** Semitone offsets from the root for the chords of each mode. */
const PROGRESSIONS: Record<Exclude<MusicMode, 'off'>, number[][]> = {
  // A aeolian: i – VI – III – VII
  calm: [
    [0, 3, 7],
    [-4, 0, 3],
    [3, 7, 10],
    [-2, 2, 5],
  ],
  // D phrygian-ish: i – bII – i – v
  battle: [
    [0, 3, 7],
    [1, 5, 8],
    [0, 3, 7],
    [-5, -2, 2],
  ],
};
const ROOT: Record<Exclude<MusicMode, 'off'>, number> = { calm: 220, battle: 146.83 };
/** Pentatonic-ish scale (semitones) for the sparse melody. */
const SCALE = [0, 3, 5, 7, 10, 12, 15];
const LOOKAHEAD = 1.5;

const hz = (root: number, semis: number): number => root * Math.pow(2, semis / 12);

export class MusicEngine {
  private readonly out: GainNode;
  private readonly delay: DelayNode;
  private mode: MusicMode = 'off';
  private bus: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextChordAt = 0;
  private nextNoteAt = 0;
  private nextPulseAt = 0;
  private chord = 0;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.5;
    this.out.connect(dest);
    // a soft echo gives the plucks some space
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(fb);
    fb.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.out);
  }

  setVolume(v: number): void {
    this.out.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.55, this.ctx.currentTime, 0.3);
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // fade the old layer out; a fresh bus starts the new one
    const old = this.bus;
    if (old) {
      old.gain.setTargetAtTime(0, this.ctx.currentTime, 0.8);
      setTimeout(() => old.disconnect(), 4000);
    }
    this.bus = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (mode === 'off') return;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    bus.gain.setTargetAtTime(1, this.ctx.currentTime + 0.5, 1.2);
    bus.connect(this.out);
    this.bus = bus;
    const now = this.ctx.currentTime;
    this.nextChordAt = now + 0.3;
    this.nextNoteAt = now + 4;
    this.nextPulseAt = now + 1;
    this.chord = 0;
    this.timer = setInterval(() => this.schedule(), 250);
    this.schedule();
  }

  dispose(): void {
    this.setMode('off');
    this.out.disconnect();
  }

  private schedule(): void {
    const mode = this.mode;
    const bus = this.bus;
    if (mode === 'off' || !bus || this.ctx.state !== 'running') return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    const prog = PROGRESSIONS[mode];
    const root = ROOT[mode];
    while (this.nextChordAt < horizon) {
      const len = mode === 'battle' ? 8 : 11;
      this.pad(bus, prog[this.chord % prog.length].map((s) => hz(root, s)), this.nextChordAt, len + 2.5, mode === 'battle' ? 0.05 : 0.045);
      this.nextChordAt += len;
      this.chord++;
    }
    if (mode === 'calm') {
      while (this.nextNoteAt < horizon) {
        const chord = prog[(this.chord + prog.length - 1) % prog.length];
        const semis = Math.random() < 0.6 ? chord[Math.floor(Math.random() * chord.length)] + 12 : SCALE[Math.floor(Math.random() * SCALE.length)] + 12;
        this.pluck(bus, hz(root, semis), this.nextNoteAt, 0.06);
        this.nextNoteAt += 2.2 + Math.random() * 4.5;
      }
    } else {
      // battle: a low heartbeat pulse
      while (this.nextPulseAt < horizon) {
        this.pulse(bus, hz(root / 2, 0), this.nextPulseAt, 0.11);
        this.pulse(bus, hz(root / 2, 0), this.nextPulseAt + 0.32, 0.06);
        this.nextPulseAt += 1.6;
      }
    }
  }

  /** Slow-swelling chord: two slightly detuned voices per note through a gentle low-pass. */
  private pad(bus: AudioNode, freqs: number[], at: number, dur: number, level: number): void {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(380, at);
    filter.frequency.linearRampToValueAtTime(900, at + dur * 0.5);
    filter.frequency.linearRampToValueAtTime(420, at + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + dur * 0.35);
    env.gain.setValueAtTime(level, at + dur * 0.65);
    env.gain.linearRampToValueAtTime(0, at + dur);
    filter.connect(env);
    env.connect(bus);
    for (const f of freqs) {
      for (const detune of [-6, 7]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(filter);
        o.start(at);
        o.stop(at + dur + 0.1);
      }
    }
    setTimeout(() => {
      filter.disconnect();
      env.disconnect();
    }, (at - ctx.currentTime + dur + 0.5) * 1000);
  }

  /** Soft plucked note with a quick decay (and a little echo). */
  private pluck(bus: AudioNode, f: number, at: number, level: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 2.4);
    o.connect(g);
    g.connect(bus);
    g.connect(this.delay);
    o.start(at);
    o.stop(at + 2.5);
  }

  /** Low thump for the battle pulse. */
  private pulse(bus: AudioNode, f: number, at: number, level: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.6, at);
    o.frequency.exponentialRampToValueAtTime(f, at + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.5);
    o.connect(g);
    g.connect(bus);
    o.start(at);
    o.stop(at + 0.55);
  }
}
