/**
 * Procedural sound with WebAudio: every effect is synthesised from a shared
 * white-noise buffer and oscillators, so the game ships no audio files.
 *
 * Presentation only (like rendering): simulation code never imports this.
 * The context is created on the first user gesture (browser autoplay rules);
 * until then, when muted, or when WebAudio is unavailable every call is a no-op.
 */

import { MusicEngine } from './music';

export type ShotSound = 'small_arms' | 'mg' | 'hmg' | 'cannon' | 'at_rocket';
export type UiSound = 'click' | 'confirm' | 'alert' | 'radio';
export type Ambience = 'none' | 'campaign' | 'battle';

/** Most voices alive at once; extra sounds are dropped (mobile CPU budget). */
const MAX_VOICES = 28;
/** New spatial sounds started per animation frame. */
const FRAME_BUDGET = 6;

interface NoiseOpts {
  /** Seconds from now. */
  at?: number;
  dur: number;
  type: BiquadFilterType;
  freq: number;
  /** Optional filter sweep target (Hz) over the duration. */
  freqTo?: number;
  q?: number;
  gain: number;
  attack?: number;
  pan?: number;
  dest?: AudioNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private amb: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.7;
  private muted = false;
  private voices = 0;
  private budget = FRAME_BUDGET;
  private listener = { x: 0, z: 0, rightX: 1, rightZ: 0, hearing: 500 };
  private ambienceMode: Ambience = 'none';
  private ambienceNodes: AudioNode[] = [];
  private lastUi = 0;
  private music: MusicEngine | null = null;
  private musicVolume = 0.6;

  get available(): boolean {
    return this.ctx !== null;
  }

  /** Create / resume the audio context. Call from a user gesture handler. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return;
    }
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      // gentle bus compression keeps stacked gunfire from clipping
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      comp.connect(this.master);
      this.sfx = ctx.createGain();
      this.sfx.connect(comp);
      this.amb = ctx.createGain();
      this.amb.connect(this.master);
      this.music = new MusicEngine(ctx, this.master);
      this.music.setVolume(this.musicVolume);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.applyVolume();
      const mode = this.ambienceMode;
      this.ambienceMode = 'none';
      this.setAmbience(mode);
    } catch {
      this.ctx = null;
    }
  }

  /** Music level 0..1 (0 = off); the master volume and mute apply on top. */
  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    this.music?.setVolume(this.musicVolume);
    this.syncMusic();
  }

  private syncMusic(): void {
    const m = this.ambienceMode;
    this.music?.setMode(this.musicVolume <= 0 ? 'off' : m === 'battle' ? 'battle' : m === 'campaign' ? 'calm' : 'off');
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.ctx || !this.master) return;
    const v = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private get live(): boolean {
    return !!this.ctx && !this.muted && this.volume > 0 && this.ctx.state === 'running';
  }

  /** Reset the per-frame budget for spatial sounds. */
  beginFrame(): void {
    this.budget = FRAME_BUDGET;
  }

  /**
   * Ear position on the ground (camera focus), the camera's screen-right
   * direction for panning, and how far sounds carry (grows when zoomed out).
   */
  setListener(x: number, z: number, rightX: number, rightZ: number, hearing: number): void {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.rightX = rightX;
    this.listener.rightZ = rightZ;
    this.listener.hearing = hearing;
  }

  private spatial(x: number, z: number): { gain: number; pan: number } | null {
    const l = this.listener;
    const dx = x - l.x;
    const dz = z - l.z;
    const d = Math.hypot(dx, dz);
    const f = 1 - d / l.hearing;
    if (f <= 0.02) return null;
    const pan = Math.max(-0.9, Math.min(0.9, (dx * l.rightX + dz * l.rightZ) / (d + 60)));
    return { gain: f * f, pan };
  }

  private take(): boolean {
    if (!this.live || this.voices >= MAX_VOICES) return false;
    if (this.budget <= 0) return false;
    this.budget--;
    return true;
  }

  private out(pan: number): AudioNode {
    const ctx = this.ctx!;
    if (!pan || !ctx.createStereoPanner) return this.sfx!;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.sfx!);
    return p;
  }

  private noiseBurst(o: NoiseOpts): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true; // long bursts run past the 1 s buffer
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.setValueAtTime(o.freq, t0);
    if (o.freqTo) filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t0 + o.dur);
    filter.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    const attack = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(o.dest ?? this.out(o.pan ?? 0));
    const offset = Math.random() * 0.8;
    this.voices++;
    src.onended = () => {
      this.voices--;
      g.disconnect();
    };
    src.start(t0, offset, o.dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', at = 0, freqTo?: number, pan = 0): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.out(pan));
    this.voices++;
    osc.onended = () => {
      this.voices--;
      g.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // ---------------------------------------------------------------------------
  // Battle sounds
  // ---------------------------------------------------------------------------

  shot(kind: ShotSound, x: number, _y: number, z: number): void {
    const s = this.spatial(x, z);
    if (!s || !this.take()) return;
    const { gain, pan } = s;
    switch (kind) {
      case 'small_arms':
        for (let k = 0; k < 2; k++) this.noiseBurst({ at: k * 0.09 + Math.random() * 0.03, dur: 0.06, type: 'bandpass', freq: 2300, q: 1.1, gain: 0.22 * gain, pan });
        break;
      case 'mg':
        for (let k = 0; k < 4; k++) this.noiseBurst({ at: k * 0.075, dur: 0.05, type: 'bandpass', freq: 1700, q: 1, gain: 0.2 * gain, pan });
        break;
      case 'hmg':
        for (let k = 0; k < 3; k++) this.noiseBurst({ at: k * 0.11, dur: 0.09, type: 'bandpass', freq: 950, q: 0.9, gain: 0.32 * gain, pan });
        break;
      case 'cannon':
        this.noiseBurst({ dur: 0.75, type: 'lowpass', freq: 900, freqTo: 120, gain: 0.9 * gain, pan, attack: 0.003 });
        this.tone(70, 0.35, 0.55 * gain, 'sine', 0, 38, pan);
        break;
      case 'at_rocket':
        this.noiseBurst({ dur: 0.45, type: 'bandpass', freq: 500, freqTo: 2600, q: 1.4, gain: 0.3 * gain, pan, attack: 0.03 });
        break;
    }
  }

  explosion(x: number, _y: number, z: number, size: number, delay = 0): void {
    const s = this.spatial(x, z);
    if (!s || !this.take()) return;
    const k = Math.min(1.6, 0.5 + size * 0.45);
    this.noiseBurst({ at: delay, dur: 0.9 + size * 0.35, type: 'lowpass', freq: 1100, freqTo: 70, gain: 0.75 * k * s.gain, pan: s.pan, attack: 0.004 });
    this.tone(48, 0.5 + size * 0.15, 0.5 * k * s.gain, 'sine', delay, 28, s.pan);
  }

  // ---------------------------------------------------------------------------
  // Interface sounds
  // ---------------------------------------------------------------------------

  ui(kind: UiSound): void {
    if (!this.live || this.voices >= MAX_VOICES) return;
    const now = performance.now();
    if (kind === 'click' && now - this.lastUi < 40) return;
    this.lastUi = now;
    switch (kind) {
      case 'click':
        this.tone(1250, 0.035, 0.05, 'square');
        break;
      case 'confirm':
        this.tone(820, 0.05, 0.06, 'triangle');
        this.tone(1230, 0.06, 0.05, 'triangle', 0.06);
        break;
      case 'alert':
        for (let k = 0; k < 3; k++) {
          this.tone(660, 0.12, 0.08, 'square', k * 0.3);
          this.tone(880, 0.12, 0.08, 'square', k * 0.3 + 0.14);
        }
        break;
      case 'radio':
        this.noiseBurst({ dur: 0.22, type: 'bandpass', freq: 1800, q: 2.5, gain: 0.07 });
        this.tone(1600, 0.08, 0.035, 'sine', 0.2, 1100);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Ambience
  // ---------------------------------------------------------------------------

  /** Looping wind bed: soft on the strategic map, stronger on the battlefield. */
  setAmbience(mode: Ambience): void {
    if (mode === this.ambienceMode) return;
    this.ambienceMode = mode;
    this.syncMusic();
    const ctx = this.ctx;
    if (!ctx || !this.amb || !this.noise) return;
    for (const n of this.ambienceNodes) {
      try {
        if (n instanceof AudioScheduledSourceNode) n.stop();
        n.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.ambienceNodes = [];
    if (mode === 'none') return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mode === 'battle' ? 520 : 320;
    const g = ctx.createGain();
    const base = mode === 'battle' ? 0.05 : 0.032;
    g.gain.value = base;
    // slow gusts
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ctx.createGain();
    depth.gain.value = base * 0.55;
    lfo.connect(depth);
    depth.connect(g.gain);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.amb);
    src.start();
    lfo.start();
    this.ambienceNodes = [src, lfo, filter, g, depth];
  }
}
