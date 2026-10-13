// Feeds synthetic plucked strings through the real tracker and checks the readings.
// Run: npm run check:pitch
import { PitchTracker, WINDOW, noteFromFrequency } from '../src/pitch.ts';

const SAMPLE_RATE = 48000;
// Standard tuning, low to high, as MIDI note numbers.
const OPEN_STRINGS = [
  { label: 'E', midi: 40 },
  { label: 'A', midi: 45 },
  { label: 'D', midi: 50 },
  { label: 'G', midi: 55 },
  { label: 'B', midi: 59 },
  { label: 'e', midi: 64 },
];
const FRAMES = 40; // ~two-thirds of a second at 60 fps
const HOP = Math.round(SAMPLE_RATE / 60);

// Seeded noise so a failure reproduces exactly.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** A plucked-string-ish tone: strong 2nd harmonic, slight inharmonicity, decay, room noise. */
function pluck(hz, seconds) {
  const harmonics = [1, 1.4, 0.8, 0.5, 0.35, 0.2, 0.12];
  const phases = harmonics.map(() => random() * Math.PI * 2);
  const out = new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    harmonics.forEach((amp, h) => {
      const n = h + 1;
      const f = n * hz * Math.sqrt(1 + 0.0001 * n * n);
      v += amp * Math.exp(-t * (1.2 + n * 0.6)) * Math.sin(2 * Math.PI * f * t + phases[h]);
    });
    out[i] = v * 0.12 + (random() - 0.5) * 0.002;
  }
  return out;
}

function track(signal) {
  const tracker = new PitchTracker(SAMPLE_RATE);
  const readings = [];
  for (let f = 0; f < FRAMES; f++) {
    const start = f * HOP;
    readings.push(tracker.update(signal.subarray(start, start + WINDOW)));
  }
  return readings;
}

const hzFor = (midi, cents) => 440 * 2 ** ((midi - 69 + cents / 100) / 12);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// Every open string, in tune and detuned both ways.
for (const string of OPEN_STRINGS) {
  for (const cents of [0, +7, -13, +31, -42]) {
    const readings = track(pluck(hzFor(string.midi, cents), 1)).slice(4); // skip warm-up
    const notes = readings.filter((r) => r !== null).map((hz) => noteFromFrequency(hz));
    const wrongNote = notes.filter((n) => n.midi !== string.midi).length;
    const worst = Math.max(...notes.map((n) => Math.abs(n.cents - cents)));
    check(
      notes.length === readings.length && wrongNote === 0 && worst < 1.5,
      `${string.label} (midi ${string.midi}) ${cents >= 0 ? '+' : ''}${cents}¢ → ` +
        `${notes.length}/${readings.length} read, ${wrongNote} wrong note, worst error ${worst.toFixed(2)}¢`,
    );
  }
}

// Silence and pure noise must not produce a note.
const silent = track(new Float32Array(WINDOW + HOP * FRAMES));
check(silent.every((r) => r === null), 'silence reads nothing');
const noise = Float32Array.from({ length: WINDOW + HOP * FRAMES }, () => (random() - 0.5) * 0.3);
const noiseHits = track(noise).filter((r) => r !== null).length;
check(noiseHits === 0, `loud white noise reads nothing (${noiseHits} false readings)`);

// Note naming.
const named = (hz) => {
  const n = noteFromFrequency(hz);
  return `${n.name}${n.octave} ${n.cents >= 0 ? '+' : ''}${n.cents.toFixed(1)}`;
};
check(named(440) === 'A4 +0.0', `440 Hz → ${named(440)}`);
check(named(82.4069) === 'E2 +0.0', `82.41 Hz → ${named(82.4069)}`);
check(named(466.1638) === 'A♯4 +0.0', `466.16 Hz → ${named(466.1638)}`);
check(named(261.6256) === 'C4 +0.0', `261.63 Hz → ${named(261.6256)}`);

// A4 reference: the same pitch reads differently against a different reference.
const against = (hz, a4) => {
  const n = noteFromFrequency(hz, a4);
  return `${n.name}${n.octave} ${n.cents >= 0 ? '+' : ''}${n.cents.toFixed(1)}`;
};
check(against(442, 442) === 'A4 +0.0', `442 Hz with A4 = 442 → ${against(442, 442)}`);
check(against(440, 442) === 'A4 -7.9', `440 Hz with A4 = 442 → ${against(440, 442)}`);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
