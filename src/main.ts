import './style.css';
import { PitchTracker, WINDOW, noteFromFrequency, type Note } from './pitch.ts';
import { CLOSE_CENTS, Reading, type Palette } from './reading.ts';
import { Grille } from './grille.ts';
import { Dial } from './dial.ts';
import { WARNING } from './pixelfont.ts';

type Power = 'off' | 'starting' | 'on' | 'error';

// ---------- Settings ----------

/**
 * Every segmented control in the controls tray. In the markup, a control names its
 * setting in data-setting and each segment its value in data-value.
 */
const CHOICES = {
  colors: ['green-red', 'teal-magenta', 'blue-orange'],
  theme: ['dark', 'light'],
  glow: ['off', 'low', 'hi'],
  gradient: ['on', 'off'],
  tolerance: ['tight', 'mid', 'loose'],
  response: ['calm', 'mid', 'quick'],
  settle: ['short', 'mid', 'long'],
  autoOff: ['off', '2', '5'],
} as const;
type Choice = keyof typeof CHOICES;
type Settings = { [K in Choice]: (typeof CHOICES)[K][number] } & {
  /** Contrast dial step, -5..+5. */
  contrast: number;
  /** Mic sensitivity dial step, 0..10. */
  sensitivity: number;
};

const DEFAULTS: Settings = {
  colors: 'green-red',
  theme: 'dark',
  glow: 'low',
  gradient: 'on',
  tolerance: 'mid',
  response: 'mid',
  settle: 'mid',
  autoOff: 'off',
  contrast: 0,
  sensitivity: 5,
};
const SETTINGS_KEY = 'tuner.settings';

/** Spot on, in cents either side of pitch. */
const TOLERANCE_CENTS = { tight: 1, mid: 2, loose: 3 };
/** Time constant for the reading following pitch, in ms. */
const RESPONSE_MS = { calm: 160, mid: 100, quick: 55 };
/** How long a note must hold spot on before the display confirms it (its dwell time). */
const SETTLE_MS = { short: 150, mid: 300, long: 600 };
/** Silence before the tuner switches itself off. */
const AUTO_OFF_MS = { off: Infinity, '2': 2 * 60_000, '5': 5 * 60_000 };
const GLOW = {
  off: { bloom: 0, blur: 0, led: 0 },
  low: { bloom: 0.3, blur: 5, led: 6 },
  hi: { bloom: 0.55, blur: 8, led: 11 },
};

/** Resting tones for each theme, and its deeper or brighter version of each color pair. */
const THEMES = {
  dark: {
    themeColor: '#1b1c1f',
    tones: { idle: [63, 67, 74], note: [244, 243, 238], rest: [37, 40, 45], peak: [210, 212, 208] },
    grille: { bore: '#060708', lip: 'rgb(255 255 255 / 0.07)', lit: [244, 241, 232] },
    pairs: {
      'green-red': { good: [46, 226, 122], bad: [255, 59, 47] },
      'teal-magenta': { good: [32, 214, 199], bad: [255, 64, 166] },
      'blue-orange': { good: [64, 144, 255], bad: [255, 140, 26] },
    },
  },
  light: {
    themeColor: '#efede8',
    tones: { idle: [206, 203, 196], note: [26, 26, 24], rest: [226, 223, 217], peak: [88, 86, 80] },
    grille: { bore: '#9b978d', lip: 'rgb(255 255 255 / 0.6)', lit: [26, 26, 24] },
    pairs: {
      'green-red': { good: [18, 152, 74], bad: [212, 42, 30] },
      'teal-magenta': { good: [8, 150, 140], bad: [200, 30, 122] },
      'blue-orange': { good: [26, 104, 216], bad: [214, 102, 0] },
    },
  },
};

// Contrast dial: 0 (straight up) is the default; -5 dims the reading to 20%, +5 is full.
const CONTRAST_STEPS = 5;
const CONTRAST_HOME = 0.75;
const CONTRAST_MIN = 0.2;
// Mic sensitivity dial, 0..10: each step moves the noise gate 3dB; 5 is -50dB.
const SENSITIVITY_STEPS = 10;
const gateFor = (sensitivity: number) => -35 - 3 * sensitivity;

// ---------- Timing ----------

// A reading counts as live for this long after the detector last heard the note,
// so brief gaps in detection don't dim it.
const LIVE_MS = 150;
// How long the last note lingers, dimmed, after the string goes quiet.
const HOLD_MS = 1500;
// While a spot-on note is confirmed and the mic still hears sound, the reading
// stays fully lit through detection gaps, for up to this long since the last
// detection. The cap keeps talking or room noise from holding an old note up.
const SUSTAIN_MS = 2500;
const SOUND_LEVEL = 0.25;
// Each green state is entered inside its band and left 1¢ outside it, so the
// colors don't flicker at the edges.
const HYSTERESIS_CENTS = 1;
// How quickly the confirmation eases in and out, and the reading fades in and out.
const LOCK_IN_MS = 180;
const LOCK_OUT_MS = 500;
const FADE_IN_MS = 40;
const FADE_OUT_MS = 200;
// Shown while adjusting the controls with the tuner off, so the effect is visible.
const PREVIEW_NOTE = noteFromFrequency(440);
// If a lifted finger never produces a click (it slid off the key), the key comes back up.
const RELEASE_FALLBACK_MS = 400;

// ---------- Elements ----------

const el = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];

const ui = {
  root: document.documentElement,
  themeColor: el<HTMLMetaElement>('meta[name="theme-color"]'),
  device: el<HTMLElement>('.device'),
  reading: el<HTMLElement>('.reading'),
  message: el<HTMLElement>('.message'),
  messageTitle: el<HTMLElement>('.message-title'),
  messageDetail: el<HTMLElement>('.message-detail'),
  grille: el<HTMLCanvasElement>('.grille'),
  power: el<HTMLButtonElement>('.key-power'),
  controls: el<HTMLButtonElement>('.key-controls'),
  dashboard: el<HTMLElement>('.dashboard'),
  tabs: all<HTMLButtonElement>('[data-page-key]'),
  pages: all<HTMLElement>('[data-page]'),
};

const reading = new Reading(el('.lights'), el('.bloom'));
const grille = new Grille(ui.grille);
drawPixels(el('.message-icon'), WARNING);
const settings = loadSettings();

// ---------- State ----------

let power: Power = 'off';
let panelOpen = false;
let failure = { title: '', detail: '' };
let audio: { ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode; tracker: PitchTracker } | null = null;
let wakeLock: WakeLockSentinel | null = null;
let frameId = 0;
// Bumped by every start and stop, so a start that resumes after a stop knows it's stale.
let session = 0;
let startedAt = 0;

const samples = new Float32Array(WINDOW);
let note: Note | null = null;
let heardAt = -Infinity;
let tuned = false;
let close = false;
let cents = 0;
let strength = 0;
let loudness = 0;
let tunedAt = -Infinity;
let lock = 0;
let lockShown = '';
let paintedAt = performance.now();

// ---------- Controls ----------

const contrastOf = (value: number) => Math.round(value * 2 * CONTRAST_STEPS) - CONTRAST_STEPS;
new Dial(el('[data-dial="contrast"]'), {
  scale: ['−5', '−4', '−3', '−2', '−1', '0', '+1', '+2', '+3', '+4', '+5'],
  steps: 2 * CONTRAST_STEPS,
  value: (settings.contrast + CONTRAST_STEPS) / (2 * CONTRAST_STEPS),
  describe: (value) => {
    const step = contrastOf(value);
    return step > 0 ? `+${step}` : String(step);
  },
  onChange: (value) => {
    settings.contrast = contrastOf(value);
    saveSettings();
    paint(performance.now());
  },
});
new Dial(el('[data-dial="sensitivity"]'), {
  scale: ['0', '', '2', '', '4', '', '6', '', '8', '', '10'],
  steps: SENSITIVITY_STEPS,
  value: settings.sensitivity / SENSITIVITY_STEPS,
  describe: (value) => `${Math.round(value * SENSITIVITY_STEPS)} of ${SENSITIVITY_STEPS}`,
  onChange: (value) => {
    settings.sensitivity = Math.round(value * SENSITIVITY_STEPS);
    saveSettings();
    audio?.tracker.setMinVolume(gateFor(settings.sensitivity));
  },
});

// Segmented controls select the moment they're touched.
for (const control of all<HTMLElement>('[data-setting]')) {
  const setting = control.dataset.setting as Choice;
  for (const segment of control.querySelectorAll<HTMLButtonElement>('[data-value]')) {
    selectOnTouch(segment, () => choose(setting, segment.dataset.value!));
  }
}
for (const tab of ui.tabs) selectOnTouch(tab, () => showPage(tab.dataset.pageKey!));

const resizer = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    if (target === ui.reading) {
      reading.resize(contentRect.width, contentRect.height);
      ui.message.style.top = `${reading.noteCenter}px`;
    } else if (target === ui.grille) {
      grille.resize(contentRect.width, contentRect.height);
    }
  }
  fitLid();
  paint(performance.now());
});
resizer.observe(ui.reading);
resizer.observe(ui.grille);
resizer.observe(ui.dashboard);

applySettings();
showPage('display');
setPower('off');

pushKey(ui.power, () => (power === 'on' || power === 'starting' ? stop() : start()));
pushKey(ui.controls, () => {
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

/**
 * A push-push key. It goes down the instant a finger lands and stays down until its
 * action has run, then moves straight to its new position: latched or out. Releasing
 * it on finger-up instead would let it bounce up before the state flipped.
 * The action runs on click, which iOS requires before it will open the microphone.
 */
function pushKey(key: HTMLButtonElement, action: () => void) {
  let fallback = 0;
  const release = () => {
    clearTimeout(fallback);
    key.classList.remove('pressed');
  };
  key.addEventListener('pointerdown', () => {
    clearTimeout(fallback);
    key.classList.add('pressed');
  });
  key.addEventListener('pointerup', () => {
    fallback = window.setTimeout(release, RELEASE_FALLBACK_MS);
  });
  key.addEventListener('pointercancel', release);
  key.addEventListener('pointerleave', (event) => {
    // A touch keeps its key until it lifts; a mouse dragged off lets go.
    if (event.pointerType === 'mouse') release();
  });
  key.addEventListener('click', () => {
    action();
    release();
  });
}

/** A segment acts the moment it's touched; click covers the keyboard. */
function selectOnTouch(segment: HTMLButtonElement, action: () => void) {
  segment.addEventListener('pointerdown', action);
  segment.addEventListener('click', action);
}

/** Slides a segmented control's highlight under its selected segment. */
function placeThumb(control: HTMLElement, segments: HTMLElement[], selected: number) {
  control.style.setProperty('--count', String(segments.length));
  control.style.setProperty('--index', String(Math.max(0, selected)));
}

function choose(setting: Choice, value: string) {
  if (settings[setting] === value) return;
  (settings as Record<Choice, string>)[setting] = value;
  saveSettings();
  applySettings();
  paint(performance.now());
}

/** Pushes every setting out to the display, the CSS and the keys that show it. */
function applySettings() {
  const theme = THEMES[settings.theme];
  const pair = theme.pairs[settings.colors];
  ui.root.dataset.theme = settings.theme;
  ui.themeColor.content = theme.themeColor;
  reading.setPalette({ ...theme.tones, ...pair } satisfies Palette);
  grille.setColors(theme.grille);
  ui.root.style.setProperty('--good-rgb', pair.good.join(' '));

  const glow = GLOW[settings.glow];
  ui.root.style.setProperty('--bloom', String(glow.bloom));
  ui.root.style.setProperty('--bloom-blur', `${glow.blur}px`);
  ui.root.style.setProperty('--led-glow', `${glow.led}px`);
  // Light glowing around dark holes would read as a smudge on the pale casing.
  grille.setGlow(settings.theme === 'dark' ? glow.led : 0);
  ui.device.dataset.gradient = settings.gradient;

  for (const control of all<HTMLElement>('[data-setting]')) {
    const current = settings[control.dataset.setting as Choice];
    const segments = [...control.querySelectorAll<HTMLElement>('[data-value]')];
    segments.forEach((segment) => segment.setAttribute('aria-checked', String(segment.dataset.value === current)));
    placeThumb(control, segments, segments.findIndex((segment) => segment.dataset.value === current));
  }
  // Color segments show their own pair, as this theme draws it, in two swatches.
  for (const key of all<HTMLElement>('[data-setting="colors"] [data-value]')) {
    const swatch = theme.pairs[key.dataset.value as Settings['colors']];
    const [good, bad] = key.querySelectorAll<HTMLElement>('.swatches i');
    good.style.background = `rgb(${swatch.good.join(' ')})`;
    bad.style.background = `rgb(${swatch.bad.join(' ')})`;
  }
}

/** Two pages share the tray; the hidden one keeps its space so the tray never resizes. */
function showPage(page: string) {
  for (const tab of ui.tabs) tab.setAttribute('aria-selected', String(tab.dataset.pageKey === page));
  placeThumb(ui.tabs[0].parentElement!, ui.tabs, ui.tabs.findIndex((tab) => tab.dataset.pageKey === page));
  for (const panel of ui.pages) {
    const shown = panel.dataset.page === page;
    panel.classList.toggle('shown', shown);
    panel.inert = !shown;
  }
}

// ---------- Power ----------

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
  const tracker = new PitchTracker(ctx.sampleRate);
  tracker.setMinVolume(gateFor(settings.sensitivity));
  audio = { ctx, stream, analyser, tracker };

  // Both checks ignore events from an earlier session that is still shutting down.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    if (audio?.stream === stream) stop();
  });
  ctx.addEventListener('statechange', () => {
    // A phone call or Siri suspends the context out from under us.
    if (audio?.ctx === ctx && ctx.state !== 'running') stop();
  });

  keepScreenAwake();
  startedAt = performance.now();
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
  loudness = 0;
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

// ---------- Reading ----------

function loop(now: number) {
  if (audio) {
    // Auto-off: long enough without a note, the tuner switches itself off.
    if (now - Math.max(heardAt, startedAt) > AUTO_OFF_MS[settings.autoOff]) return stop();
    audio.analyser.getFloatTimeDomainData(samples);
    loudness = inputLevel(samples);
    grille.draw(loudness);
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
  const elapsed = Math.min(100, Math.max(0, now - paintedAt));
  paintedAt = now;
  const ease = (ms: number) => 1 - Math.exp(-elapsed / ms);

  const step = settings.contrast / CONTRAST_STEPS; // -1..1
  const brightness = CONTRAST_HOME + step * (step < 0 ? CONTRAST_HOME - CONTRAST_MIN : 1 - CONTRAST_HOME);
  const spot = TOLERANCE_CENTS[settings.tolerance];

  const preview = panelOpen && (power === 'off' || power === 'error');
  ui.device.dataset.preview = String(preview);
  if (preview) {
    showLock(1);
    reading.draw({
      mode: 'live',
      time: now,
      note: PREVIEW_NOTE,
      cents: 0,
      strength: 1,
      tuned: true,
      close: true,
      spot,
      brightness,
      lock: 1,
    });
    return;
  }

  const age = now - heardAt;
  const sustained = lock > 0.05 && loudness > SOUND_LEVEL && age < SUSTAIN_MS;
  const live = power === 'on' && (age < LIVE_MS || sustained);
  const held = power === 'on' && !live && age < HOLD_MS;

  if ((live || held) && note) {
    // Jump straight to the first reading; glide after that.
    cents = strength < 0.02 ? note.cents : cents + (note.cents - cents) * ease(RESPONSE_MS[settings.response]);
    const off = Math.abs(note.cents);
    const was = tuned;
    tuned = off < spot + (tuned ? HYSTERESIS_CENTS : 0);
    close = tuned || off < CLOSE_CENTS + (close ? HYSTERESIS_CENTS : 0);
    if (tuned && !was) tunedAt = now;
  } else {
    tuned = false;
    close = false;
  }
  // The confirmation only comes once the note has held spot on for the settle time.
  const locked = tuned && now - tunedAt >= SETTLE_MS[settings.settle];
  if (power === 'on') {
    lock += ((locked ? 1 : 0) - lock) * ease(locked ? LOCK_IN_MS : LOCK_OUT_MS);
    if (lock < 0.005) lock = 0;
  } else {
    // Nothing is animating when the tuner isn't listening, so don't leave it mid-fade.
    lock = 0;
  }
  showLock(lock);

  const target = live ? 1 : held ? 0.5 : 0;
  strength += (target - strength) * ease(target > strength ? FADE_IN_MS : FADE_OUT_MS);
  if (strength < 0.005) strength = 0;

  reading.draw({
    // An error keeps the grey bars up, so the device reads as on but stalled.
    mode: power === 'on' ? 'live' : power === 'starting' ? 'loading' : power === 'error' ? 'idle' : 'dark',
    time: now,
    note,
    cents,
    strength,
    tuned,
    close,
    spot,
    brightness,
    lock,
  });
}

/** Drives the green gradient at the top of the screen, in fortieths to limit restyling. */
function showLock(amount: number) {
  const step = (Math.round(amount * 40) / 40).toFixed(3);
  if (step === lockShown) return;
  lockShown = step;
  ui.device.style.setProperty('--lock', step);
}

/**
 * How the screen lifts to uncover the controls tray: its bottom edge rises by the
 * tray's height, and the reading moves up by half that so it stays centered in what's
 * left, shrinking only if it wouldn't otherwise fit. CSS animates both as transforms,
 * so the reading is never redrawn mid-lift.
 */
function fitLid() {
  const tray = ui.dashboard.offsetHeight;
  const visible = ui.reading.clientHeight - tray;
  const fit = Math.min(1, (visible - 24) / (reading.compositionHeight || 1));
  ui.device.style.setProperty('--tray', `${tray}px`);
  ui.device.style.setProperty('--shift', `${-tray / 2}px`);
  // The reading gives way generously: the tray's room matters more while it's open.
  ui.device.style.setProperty('--fit', Math.max(0.25, fit).toFixed(3));
}

// ---------- Storage ----------

function loadSettings(): Settings {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    // Storage unavailable or corrupt: defaults.
  }
  const loaded = { ...DEFAULTS };
  for (const choice of Object.keys(CHOICES) as Choice[]) {
    const value = saved[choice];
    if ((CHOICES[choice] as readonly unknown[]).includes(value)) (loaded as Record<Choice, unknown>)[choice] = value;
  }
  // Contrast was called brightness before it became a -5..+5 dial.
  const contrast = saved.contrast ?? saved.brightness;
  if (Number.isInteger(contrast) && Math.abs(contrast as number) <= CONTRAST_STEPS) loaded.contrast = contrast as number;
  const sensitivity = saved.sensitivity;
  if (Number.isInteger(sensitivity) && (sensitivity as number) >= 0 && (sensitivity as number) <= SENSITIVITY_STEPS) {
    loaded.sensitivity = sensitivity as number;
  }
  return loaded;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage blocked: settings last for this session only.
  }
}

// ---------- Helpers ----------

/** Solid square pixels into an SVG, one unit each, so the icon stays crisp at any size. */
function drawPixels(svg: SVGSVGElement, rows: string[]) {
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    rows.flatMap((row, y) => [...row].map((dot, x) => (dot === '#' ? `M${x} ${y}h1v1h-1z` : ''))).join(''),
  );
  svg.append(path);
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
