import './style.css';
import { PitchTracker, WINDOW, STANDARD_TUNING, nearestString, noteFromFrequency, type Note } from './pitch.ts';

type State = 'idle' | 'starting' | 'listening';
type Signal = 'live' | 'held' | 'none';

// How long the last note stays on screen after the string goes quiet.
const HOLD_MS = 1500;
// Needle easing per frame: high enough to feel immediate, low enough to stop jitter.
const NEEDLE_EASE = 0.35;
// In-tune band with hysteresis so the green doesn't flicker at the edge.
const TUNED_ENTER = 3;
const TUNED_EXIT = 5;

const SVG_NS = 'http://www.w3.org/2000/svg';
const PIVOT_X = 160;
const PIVOT_Y = 160;
const TICK_RADIUS = 140;

const el = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const ui = {
  root: el<HTMLElement>('.tuner'),
  ticks: el<SVGGElement>('.ticks'),
  needle: el<SVGGElement>('.needle'),
  letter: el<HTMLElement>('.letter'),
  accidental: el<HTMLElement>('.accidental'),
  octave: el<HTMLElement>('.octave'),
  cents: el<HTMLElement>('.cents'),
  strings: el<HTMLOListElement>('.strings'),
  start: el<HTMLButtonElement>('.start'),
  pill: el<HTMLElement>('.pill'),
  error: el<HTMLElement>('.error'),
};

let state: State = 'idle';
let audio: { ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode; tracker: PitchTracker } | null = null;
let wakeLock: WakeLockSentinel | null = null;
let frameId = 0;
// Bumped by every start and stop, so a start that resumes after a stop knows it's stale.
let session = 0;

const samples = new Float32Array(WINDOW);
let note: Note | null = null;
let heardAt = -Infinity;
let needleCents = 0;
let tuned = false;
let shown = '';

buildGauge();
buildStrings();
ui.start.addEventListener('click', start);
document.addEventListener('visibilitychange', () => {
  // Release the mic whenever the app leaves the screen; a tap brings it back.
  if (document.hidden) stop();
});

async function start() {
  if (state !== 'idle') return;
  const id = ++session;
  setState('starting');

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return fail('The microphone only works over a secure (https) connection.');
  }

  // iOS only lets audio start inside a tap, so the context is created and resumed
  // here, before the permission prompt.
  const ctx = new AudioContext();
  const resumed = ctx.resume().catch(() => {});

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Raw input: phone-call processing treats a held note as noise and fades it.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    ctx.close();
    return fail(micErrorMessage(err));
  }
  await resumed;

  if (id !== session) {
    // The app was backgrounded while the permission prompt was up.
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    return;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = WINDOW;
  ctx.createMediaStreamSource(stream).connect(analyser);
  audio = { ctx, stream, analyser, tracker: new PitchTracker(ctx.sampleRate) };

  // Both checks ignore events from an earlier session that is still shutting down.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (audio?.stream === stream) stop();
  });
  ctx.addEventListener('statechange', () => {
    // A phone call or Siri suspends the context out from under us.
    if (audio?.ctx === ctx && ctx.state !== 'running') stop();
  });

  keepScreenAwake();
  setState('listening');
  frameId = requestAnimationFrame(frame);
}

function stop() {
  session++;
  cancelAnimationFrame(frameId);
  if (audio) {
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
  }
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  note = null;
  heardAt = -Infinity;
  needleCents = 0;
  render(performance.now());
  setState('idle');
}

function fail(message: string) {
  ui.error.textContent = message;
  ui.error.hidden = false;
  setState('idle');
}

function setState(next: State) {
  state = next;
  ui.root.dataset.state = next;
  ui.pill.textContent = next === 'starting' ? 'Starting…' : 'Tap to tune';
  if (next === 'listening') ui.error.hidden = true;
}

function frame(now: number) {
  if (!audio) return;
  audio.analyser.getFloatTimeDomainData(samples);
  const hz = audio.tracker.update(samples);
  if (hz !== null) {
    note = noteFromFrequency(hz);
    heardAt = now;
  }
  render(now);
  frameId = requestAnimationFrame(frame);
}

function render(now: number) {
  const signal: Signal = now - heardAt < 50 ? 'live' : now - heardAt < HOLD_MS ? 'held' : 'none';
  const current = signal === 'none' ? null : note;

  const target = current ? current.cents : 0;
  needleCents += (target - needleCents) * NEEDLE_EASE;
  const degrees = Math.max(-55, Math.min(55, needleCents)); // one degree per cent
  ui.needle.setAttribute('transform', `rotate(${degrees.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`);

  if (current) {
    const off = Math.abs(current.cents);
    tuned = tuned ? off < TUNED_EXIT : off < TUNED_ENTER;
  } else {
    tuned = false;
  }

  // Text and classes only change when what they'd show changes.
  const rounded = current ? Math.round(current.cents) : 0;
  const key = current ? `${current.midi}|${rounded}|${signal}|${tuned}` : 'none';
  if (key === shown) return;
  shown = key;

  ui.root.dataset.signal = signal;
  ui.root.dataset.tuned = String(tuned);

  if (!current) {
    ui.letter.textContent = '–';
    ui.accidental.textContent = '';
    ui.octave.textContent = '';
    ui.cents.textContent = 'Play a string';
    markString(-1);
    return;
  }

  ui.letter.textContent = current.name[0];
  ui.accidental.textContent = current.name.slice(1);
  ui.octave.textContent = String(current.octave);
  ui.cents.textContent = tuned ? 'In tune' : `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}¢`;
  markString(nearestString(current));
}

function markString(index: number) {
  [...ui.strings.children].forEach((li, i) => li.classList.toggle('active', i === index));
}

function buildGauge() {
  for (let cents = -50; cents <= 50; cents += 5) {
    const kind = cents === 0 ? 'center' : cents % 10 === 0 ? 'major' : 'minor';
    const inner = kind === 'center' ? 112 : kind === 'major' ? 122 : 130;
    const [x1, y1] = polar(inner, cents);
    const [x2, y2] = polar(TICK_RADIUS, cents);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', kind);
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    ui.ticks.append(line);
  }
}

function buildStrings() {
  for (const string of STANDARD_TUNING) {
    const li = document.createElement('li');
    li.textContent = string.label;
    ui.strings.append(li);
  }
}

/** A point on the gauge, `degrees` clockwise from straight up. */
function polar(radius: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [PIVOT_X + radius * Math.sin(a), PIVOT_Y - radius * Math.cos(a)];
}

async function keepScreenAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // Not supported or denied; the screen just follows auto-lock.
  }
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it for this site in your browser settings, then tap to try again.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'Another app is using the microphone. Close it, then tap to try again.';
  return 'The microphone could not start. Tap to try again.';
}
