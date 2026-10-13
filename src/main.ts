import './style.css';
import { PitchTracker, WINDOW, noteFromFrequency, type Note } from './pitch.ts';
import { Reading } from './reading.ts';
import { Grille } from './grille.ts';
import { Dial } from './dial.ts';

type Power = 'off' | 'starting' | 'on' | 'error';

// How long the last note lingers after the string goes quiet.
const HOLD_MS = 1500;
// In-tune band with hysteresis so the green doesn't flicker at the edge.
const TUNED_ENTER = 3;
const TUNED_EXIT = 5;
// Per-frame easing: the reading follows pitch quickly, fades in fast and out slowly.
const FOLLOW = 0.3;
const FADE_IN = 0.35;
const FADE_OUT = 0.08;

// The glow dial's five detents: off, then 1–4.
const GLOW_LABELS = ['off', '1', '2', '3', '4'];
const GLOW_LEVELS = [
  { bloom: 0, blur: 0, led: 0 },
  { bloom: 0.2, blur: 4, led: 4 },
  { bloom: 0.35, blur: 6, led: 7 },
  { bloom: 0.5, blur: 8, led: 10 },
  { bloom: 0.68, blur: 10, led: 14 },
];
// The brightness dial never goes fully dark.
const MIN_BRIGHTNESS = 0.2;
const SETTINGS_KEY = 'tuner.settings';
// Shown while adjusting the dials with the tuner off, so the effect is visible.
const PREVIEW_NOTE = noteFromFrequency(440);

const el = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const ui = {
  device: el<HTMLElement>('.device'),
  reading: el<HTMLElement>('.reading'),
  message: el<HTMLElement>('.message'),
  messageTitle: el<HTMLElement>('.message-title'),
  messageDetail: el<HTMLElement>('.message-detail'),
  grille: el<HTMLCanvasElement>('.grille'),
  power: el<HTMLButtonElement>('.key-power'),
  controls: el<HTMLButtonElement>('.key-controls'),
  dashboard: el<HTMLElement>('.dashboard'),
};

const reading = new Reading(el('.lights'), el('.bloom'));
const grille = new Grille(ui.grille);
const settings = loadSettings();

let power: Power = 'off';
let panelOpen = false;
let failure = { title: '', detail: '' };
let audio: { ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode; tracker: PitchTracker } | null = null;
let wakeLock: WakeLockSentinel | null = null;
let frameId = 0;
// Bumped by every start and stop, so a start that resumes after a stop knows it's stale.
let session = 0;

const samples = new Float32Array(WINDOW);
let note: Note | null = null;
let heardAt = -Infinity;
let tuned = false;
let cents = 0;
let strength = 0;

new Dial(el('[data-dial="brightness"]'), {
  scale: ['0', '', '2', '', '4', '', '6', '', '8', '', '10'],
  stepped: false,
  value: settings.brightness,
  describe: (value) => `${Math.round(value * 10)} of 10`,
  onChange: (value) => {
    settings.brightness = value;
    saveSettings();
    paint(performance.now());
  },
});
new Dial(el('[data-dial="glow"]'), {
  scale: GLOW_LABELS,
  stepped: true,
  value: settings.glow / (GLOW_LABELS.length - 1),
  describe: (value) => GLOW_LABELS[Math.round(value * (GLOW_LABELS.length - 1))],
  onChange: (value) => {
    settings.glow = Math.round(value * (GLOW_LABELS.length - 1));
    saveSettings();
    applyGlow();
    paint(performance.now());
  },
});

const resizer = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    if (target === ui.reading) {
      reading.resize(contentRect.width, contentRect.height);
      ui.message.style.top = `${reading.noteCenter}px`;
    } else {
      grille.resize(contentRect.width, contentRect.height);
    }
  }
  paint(performance.now());
});
resizer.observe(ui.reading);
resizer.observe(ui.grille);

applyGlow();
setPower('off');

// Keys move the instant a finger lands. Power acts on release, which iOS requires
// before it will open the microphone.
for (const key of [ui.power, ui.controls]) {
  key.addEventListener('pointerdown', () => key.classList.add('pressed'));
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    key.addEventListener(type, () => key.classList.remove('pressed'));
  }
}
ui.power.addEventListener('click', () => (power === 'on' || power === 'starting' ? stop() : start()));
ui.controls.addEventListener('click', () => {
  panelOpen = !panelOpen;
  ui.device.dataset.panel = panelOpen ? 'open' : 'closed';
  ui.controls.setAttribute('aria-pressed', String(panelOpen));
  ui.dashboard.inert = !panelOpen;
  paint(performance.now());
});

ui.reading.addEventListener('click', () => {
  if (power === 'off' || power === 'error') start();
});
document.addEventListener('visibilitychange', () => {
  // Release the mic whenever the app leaves the screen.
  if (document.hidden && (power === 'on' || power === 'starting')) stop();
});

async function start() {
  if (power === 'on' || power === 'starting') return;
  const id = ++session;
  setPower('starting');
  frameId = requestAnimationFrame(loop);

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return fail('Needs https', 'The mic only works on a secure connection');
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
    if (id === session) fail(...micError(err));
    return;
  }
  await resumed;

  if (id !== session) {
    // Switched off, or the app was backgrounded, while the prompt was up.
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
  setPower('on');
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
  strength = 0;
  grille.draw(0);
  setPower('off');
}

function fail(title: string, detail: string) {
  cancelAnimationFrame(frameId);
  failure = { title, detail };
  setPower('error');
}

function setPower(next: Power) {
  power = next;
  ui.device.dataset.power = next;
  ui.power.setAttribute('aria-pressed', String(next === 'on' || next === 'starting'));

  const message =
    next === 'off'
      ? { title: 'Tap to tune', detail: '' }
      : next === 'starting'
        ? { title: 'Starting', detail: 'Allow the mic if asked' }
        : next === 'error'
          ? { title: failure.title, detail: `${failure.detail}. Tap to retry.` }
          : { title: '', detail: '' };
  ui.messageTitle.textContent = message.title;
  ui.messageDetail.textContent = message.detail;
  paint(performance.now());
}

function loop(now: number) {
  if (audio) {
    audio.analyser.getFloatTimeDomainData(samples);
    grille.draw(inputLevel(samples));
    const hz = audio.tracker.update(samples);
    if (hz !== null) {
      note = noteFromFrequency(hz);
      heardAt = now;
    }
  }
  paint(now);
  if (power === 'on' || power === 'starting') frameId = requestAnimationFrame(loop);
}

function paint(now: number) {
  const brightness = MIN_BRIGHTNESS + (1 - MIN_BRIGHTNESS) * settings.brightness;
  const preview = panelOpen && (power === 'off' || power === 'error');
  ui.device.dataset.preview = String(preview);
  if (preview) {
    reading.draw({ mode: 'live', time: now, note: PREVIEW_NOTE, cents: 0, strength: 1, tuned: true, brightness });
    return;
  }

  const age = now - heardAt;
  const live = power === 'on' && age < 50;
  const held = power === 'on' && !live && age < HOLD_MS;

  if ((live || held) && note) {
    // Jump straight to the first reading; glide after that.
    cents = strength < 0.02 ? note.cents : cents + (note.cents - cents) * FOLLOW;
    const off = Math.abs(note.cents);
    tuned = tuned ? off < TUNED_EXIT : off < TUNED_ENTER;
  } else {
    tuned = false;
  }
  const target = live ? 1 : held ? 0.5 : 0;
  strength += (target - strength) * (target > strength ? FADE_IN : FADE_OUT);
  if (strength < 0.005) strength = 0;

  reading.draw({
    mode: power === 'on' ? 'live' : power === 'starting' ? 'sweep' : 'dark',
    time: now,
    note,
    cents,
    strength,
    tuned,
    brightness,
  });
}

function applyGlow() {
  const level = GLOW_LEVELS[settings.glow];
  ui.device.style.setProperty('--bloom', String(level.bloom));
  ui.device.style.setProperty('--bloom-blur', `${level.blur}px`);
  ui.device.style.setProperty('--led-glow', `${level.led}px`);
  grille.setGlow(level.led);
}

function loadSettings(): { brightness: number; glow: number } {
  const defaults = { brightness: 0.8, glow: 2 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return {
      brightness: typeof saved.brightness === 'number' ? Math.min(1, Math.max(0, saved.brightness)) : defaults.brightness,
      glow: Number.isInteger(saved.glow) && saved.glow >= 0 && saved.glow < GLOW_LEVELS.length ? saved.glow : defaults.glow,
    };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage blocked: settings last for this session only.
  }
}

/** Input loudness, 0..1. */
function inputLevel(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const db = 10 * Math.log10(sum / buffer.length + 1e-12);
  return Math.min(1, Math.max(0, (db + 60) / 45));
}

async function keepScreenAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // Not supported or denied; the screen just follows auto-lock.
  }
}

function micError(err: unknown): [title: string, detail: string] {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return ['Mic blocked', 'Allow microphone access for this site in settings'];
  }
  if (name === 'NotFoundError') return ['No mic', 'No microphone was found'];
  if (name === 'NotReadableError') return ['Mic busy', 'Another app is using the microphone'];
  return ['Mic error', 'The microphone could not start'];
}
