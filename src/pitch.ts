import { PitchDetector } from 'pitchy';

/** Samples per analysis window. ~85 ms at 48 kHz: seven periods of low E. */
export const WINDOW = 4096;

export const A4_DEFAULT = 440;
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Guitar range with headroom: drop-tuned low strings up to the high frets.
const MIN_HZ = 60;
const MAX_HZ = 1400;
// McLeod clarity: 1 is a pure periodic tone, noise sits well below 0.8.
const MIN_CLARITY = 0.9;
/** Default noise gate: quieter input than this is ignored. */
const MIN_VOLUME_DB = -50;
// Median over this many readings throws out one-frame octave slips.
const HISTORY = 5;
// Frames a reading survives through dropouts before the tracker lets go.
const HOLD_FRAMES = 6;

export interface Note {
  name: string;
  octave: number;
  midi: number;
  /** -50..+50, distance from `midi` in hundredths of a semitone. */
  cents: number;
  hz: number;
}

/** Names the nearest equal-tempered note, with `a4` as the reference pitch. */
export function noteFromFrequency(hz: number, a4 = A4_DEFAULT): Note {
  const exact = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(exact);
  return {
    name: NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    midi,
    cents: (exact - midi) * 100,
    hz,
  };
}

/** Turns raw microphone windows into a steady fundamental frequency. */
export class PitchTracker {
  private readonly detector = PitchDetector.forFloat32Array(WINDOW);
  private readonly sampleRate: number;
  private readonly history: number[] = [];
  private misses = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.detector.minVolumeDecibels = MIN_VOLUME_DB;
  }

  /** Moves the noise gate: lower (more negative) hears quieter strings, and more room noise. */
  setMinVolume(decibels: number) {
    this.detector.minVolumeDecibels = decibels;
  }

  /** Returns the current pitch in Hz, or null when nothing clear is playing. */
  update(samples: Float32Array): number | null {
    const [hz, clarity] = this.detector.findPitch(samples, this.sampleRate);

    if (clarity >= MIN_CLARITY && hz >= MIN_HZ && hz <= MAX_HZ) {
      this.misses = 0;
      this.history.push(hz);
      if (this.history.length > HISTORY) this.history.shift();
    } else if (++this.misses > HOLD_FRAMES) {
      this.history.length = 0;
    }

    return this.history.length ? median(this.history) : null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
