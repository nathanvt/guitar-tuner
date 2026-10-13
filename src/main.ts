import './style.css';
import { PitchTracker, WINDOW, noteFromFrequency, type Note } from './pitch.ts';
import { Reading } from './reading.ts';
import { Grille } from './grille.ts';
import { Dial } from './dial.ts';
import { WARNING } from './pixelfont.ts';

type Power = 'off' | 'starting' | 'on' | 'error';
type Glow = 'off' | 'low' | 'hi';

// How long the last note lingers after the string goes quiet.
const HOLD_MS = 1500;
// In-tune band with hysteresis so the green doesn't flicker at the edge.
const TUNED_ENTER = 3;
const TUNED_EXIT = 5;
// Per-frame easing: the reading follows pitch quickly, fades in fast and out slowly.
const FOLLOW = 0.3;
const FADE_IN = 0.35;
const FADE_OUT = 0.08;

const GLOW: Record<Glow, { bloom: number; blur: number; led: number }> = {
  off: { bloom: 0, blur: 0, led: 0 },
  low: { bloom: 0.3, blur: 5, led: 6 },
  hi: { bloom: 0.55, blur: 8, led: 11 },
};
// The brightness dial never goes fully dark.
const MIN_BRIGHTNESS = 0.2;
const SETTINGS_KEY = 'tuner.settings';
// Shown while adjusting the controls with the tuner off, so the effect is visible.
const PREVIEW_NOTE = noteFromFrequency(440);
// If a lifted finger never produces a click (it slid off the key), the key comes back up.
const RELEASE_FALLBACK_MS = 400;

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
  glowKeys: [...document.querySelectorAll<HTMLButtonElement>('[data-glow]')],
};

const reading = new Reading(el('.lights'), el('.bloom'));
drawPixels(el('.message-icon'), WARNING);
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
  value: settings.brightness,
  describe: (value) => `${Math.round(value * 10)} of 10`,
  onChange: (value) => {
    settings.brightness = value;
    saveSettings();
    paint(performance.now());
  },
});

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

setGlow(settings.glow);
setPower('off');

pushKey(ui.power, () => (power === 'on' || power === 'starting' ? stop() : start()));
pushKey(ui.controls, () => {
  panelOpen = !panelOpen;
  ui.device.dataset.panel = panelOpen ? 'open' : 'closed';
  ui.controls.setAttribute('aria-pressed', String(panelOpen));
  ui.dashboard.inert = !panelOpen;
  paint(performance.now());
});

// Interlocking keys: touching one latches it at once and releases the others.
for (const key of ui.glowKeys) {
  const choose = () => {
    const glow = key.dataset.glow as Glow;
    if (glow === settings.glow) return;
    settings.glow = glow;
    saveSettings();
    setGlow(glow);
    paint(performance.now());
  };
  key.addEventListener('pointerdown', () => {
    key.classList.add('pressed');
    choose();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    key.addEventListener(type, () => key.classList.remove('pressed'));
  }
  key.addEventListener('click', choose); // keyboard
}

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
  ui.device.style.setProperty('--fit', Math.max(0.4, fit).toFixed(3));
}

function setGlow(glow: Glow) {
  const level = GLOW[glow];
  ui.device.style.setProperty('--bloom', String(level.bloom));
  ui.device.style.setProperty('--bloom-blur', `${level.blur}px`);
  ui.device.style.setProperty('--led-glow', `${level.led}px`);
  grille.setGlow(level.led);
  for (const key of ui.glowKeys) key.setAttribute('aria-checked', String(key.dataset.glow === glow));
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
    // An error keeps the grey bars up, so the device reads as on but stalled.
    mode: power === 'on' ? 'live' : power === 'starting' ? 'sweep' : power === 'error' ? 'idle' : 'dark',
    time: now,
    note,
    cents,
    strength,
    tuned,
    brightness,
  });
}

function loadSettings(): { brightness: number; glow: Glow } {
  const defaults = { brightness: 0.8, glow: 'low' as Glow };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return {
      brightness: typeof saved.brightness === 'number' ? Math.min(1, Math.max(0, saved.brightness)) : defaults.brightness,
      glow: saved.glow in GLOW ? saved.glow : defaults.glow,
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
