/**
 * Procedural ambient score. Slow pad chords drift through modal progressions
 * over a soft bass, with sparse plucked notes and short motifs on the
 * strategic map; once the expedition is at war the map turns darker and a
 * slow pulse creeps in; on the battlefield the harmony darkens further and a
 * low heartbeat takes over. Each mode has a few progressions and switches
 * between them at the end of a cycle, so the score does not loop audibly.
 * Everything is scheduled a little ahead on the AudioContext clock from a
 * light timer, so it costs a handful of oscillators at a time.
 *
 * Presentation only; cosmetic randomness (Math.random) is fine here.
 */

export type MusicMode = 'calm' | 'tense' | 'battle' | 'off';
type Playing = Exclude<MusicMode, 'off'>;

/** Semitone offsets from the root for the chords of each mode, a few progressions per mode. */
const PROGRESSIONS: Record<Playing, number[][][]> = {
  calm: [
    // A aeolian: i – VI – III – VII
    [
      [0, 3, 7],
      [-4, 0, 3],
      [3, 7, 10],
      [-2, 2, 5],
    ],
    // i – iv – VI – v
    [
      [0, 3, 7],
      [5, 8, 12],
      [-4, 0, 3],
      [-5, -2, 2],
    ],
    // i7 – VII – VImaj7 – iv
    [
      [0, 3, 7, 10],
      [-2, 2, 5],
      [-4, 0, 3, 7],
      [5, 8, 12],
    ],
  ],
  tense: [
    // i – bII – bvii – i
    [
      [0, 3, 7],
      [1, 5, 8],
      [-2, 1, 5],
      [0, 3, 7],
    ],
    // i – VI – bII – v
    [
      [0, 3, 7],
      [-4, 0, 3],
      [1, 5, 8],
      [-5, -2, 2],
    ],
  ],
  battle: [
    // D phrygian-ish: i – bII – i – v
    [
      [0, 3, 7],
      [1, 5, 8],
      [0, 3, 7],
      [-5, -2, 2],
    ],
    // i – bvii – VI – bII
    [
      [0, 3, 7],
      [-2, 1, 5],
      [-4, 0, 3],
      [1, 5, 8],
    ],
  ],
};
const ROOT: Record<Playing, number> = { calm: 220, tense: 196, battle: 146.83 };
/** Seconds per chord. */
const CHORD_LEN: Record<Playing, number> = { calm: 11, tense: 10, battle: 8 };
/** Pentatonic-ish scale (semitones) for the sparse melody. */
const SCALE = [0, 3, 5, 7, 10, 12, 15];
const LOOKAHEAD = 1.5;

const hz = (root: number, semis: number): number => root * Math.pow(2, semis / 12);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

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
  private prog = 0;
  /** The chord sounding now (semitones), for the melody. */
  private current: number[] = [0, 3, 7];

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
    this.prog = Math.floor(Math.random() * PROGRESSIONS[mode].length);
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
    const root = ROOT[mode];
    const len = CHORD_LEN[mode];
    while (this.nextChordAt < horizon) {
      const progs = PROGRESSIONS[mode];
      const prog = progs[this.prog % progs.length];
      const chord = prog[this.chord % prog.length];
      this.current = chord;
      const at = this.nextChordAt;
      this.pad(bus, chord.map((s) => hz(root, s)), at, len + 2.5, mode === 'calm' ? 0.045 : 0.05);
      // a soft bass under the chord's root, an octave down
      this.bass(bus, hz(root / 2, chord[0] > 4 ? chord[0] - 12 : chord[0]), at, len + 1, mode === 'battle' ? 0.04 : 0.032);
      this.nextChordAt += len;
      this.chord++;
      // end of a cycle: sometimes move on to another progression
      if (this.chord % prog.length === 0 && progs.length > 1 && Math.random() < 0.6) {
        this.prog = (this.prog + 1 + Math.floor(Math.random() * (progs.length - 1))) % progs.length;
      }
    }
    if (mode !== 'battle') {
      while (this.nextNoteAt < horizon) {
        const at = this.nextNoteAt;
        const chord = this.current;
        if (mode === 'calm' && Math.random() < 0.3) {
          // a short rising motif from a chord tone
          const start = SCALE.indexOf(pick(chord.filter((s) => SCALE.includes(s))) ?? 0);
          const steps = 2 + Math.floor(Math.random() * 3);
          for (let k = 0; k < steps; k++) {
            const s = SCALE[Math.min(SCALE.length - 1, Math.max(0, start) + k)];
            this.pluck(bus, hz(root, s + 12), at + k * 0.38, 0.05);
          }
        } else {
          const semis = Math.random() < 0.6 ? pick(chord) + 12 : pick(SCALE) + 12;
          this.pluck(bus, hz(root, semis), at, mode === 'tense' ? 0.045 : 0.06);
        }
        this.nextNoteAt += mode === 'tense' ? 4 + Math.random() * 6 : 2.2 + Math.random() * 4.5;
      }
    }
    if (mode !== 'calm') {
      // battle: a low heartbeat; at war on the map: a slower, quieter pulse
      const tense = mode === 'tense';
      while (this.nextPulseAt < horizon) {
        this.pulse(bus, hz(root / 2, 0), this.nextPulseAt, tense ? 0.06 : 0.11);
        this.pulse(bus, hz(root / 2, 0), this.nextPulseAt + 0.32, tense ? 0.035 : 0.06);
        this.nextPulseAt += tense ? 3.2 : 1.6;
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

  /** Low sustained note under a chord. */
  private bass(bus: AudioNode, f: number, at: number, dur: number, level: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    // triangle: its overtones keep the line audible on phone speakers
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 1.8);
    g.gain.setValueAtTime(level, at + dur * 0.6);
    g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g);
    g.connect(bus);
    o.start(at);
    o.stop(at + dur + 0.1);
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
