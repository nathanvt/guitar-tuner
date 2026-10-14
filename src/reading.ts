import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from './pixelfont.ts';
import type { Note } from './pitch.ts';

/*
  The reading, on open space: an arc of LED bars above a pixel note. Colors come from
  the palette: the theme sets the resting tones, the color preset the good/bad pair.
    - Bars rest grey. The bar at the current pitch lights and grows longer, so both
      color and size carry the reading; its neighbors take a dim version of its
      color. It is red when off pitch and green when close (the bars either side of
      center) or spot on (the center bar).
    - Once a note has held spot on (`lock`), the rest of the arc fills grey to green
      from the center out, and the five center bars' glow brightens, also from the
      center out.
    - Between two bars, the light splits across both, so the reading glides.
    - Nothing is drawn where nothing is lit.
    - The note letter sits dead center, under the center bar, and never moves; the
      sharp and octave hang off its right side.
*/

/** Bars on each side of the center bar. */
const HALF = 8;
/** The arc spans ±60° from straight up, leaving room for the note's side column below its ends. */
const SWEEP = (60 * Math.PI) / 180;
/** Close: the bars either side of center, out to ±5¢. Spot on, the center bar, is set by the tolerance. */
export const CLOSE_CENTS = 5;
/** Beyond close, the outer bars cover the rest of ±50¢, finer toward the middle. */
const OUTER_CURVE = 0.75;
/** How much of the lit color the bars either side of the reading take. */
const NEIGHBOR = 0.35;
/** How much longer a fully lit bar grows; the center bar is the target and always longer. */
const GROW = 0.4;
const CENTER = 1.25;
/** Extra glow at full lock, added to the glow layer only, on this many bars either side of center. */
const LOCK_GLOW = 0.8;
const LOCK_GLOW_BARS = 2;
/** How far the outermost bar trails the center as the confirmation comes in, as a fraction of it. */
const ARC_STAGGER = 0.5;
const GLOW_STAGGER = 0.5;
/** Height of the whole composition, lit center bar to the note's foot, in radii. */
const COMPOSITION = 2.28;
/** Where the composition's middle sits, as a fraction of the screen's height from the top. */
const OPTICAL_CENTER = 0.46;
/** Space kept clear at the screen's top and bottom edges, in CSS pixels. */
const MARGIN = 12;
/** The note's top, in radii above the arc's center. */
const NOTE_DROP = 0.3;

// While the mic starts, waves of light radiate out from the center bar: each bar
// pulses from `rest` to `peak`, the ends a little after the center.
const RIPPLE_MS = 1300;
/** How far behind the center the end bars pulse, as a fraction of a ripple. */
const RIPPLE_LAG = 0.45;
// Listening with nothing to read: the same ripple, slower and fainter, so the bars
// show the tuner is still awake. It fades in as the last note fades out.
const IDLE_RIPPLE_MS = 2600;
const IDLE_RIPPLE_DEPTH = 0.3;

export interface Palette {
  /** Resting bars. */
  idle: number[];
  note: number[];
  /** Close and spot on. */
  good: number[];
  /** Off pitch. */
  bad: number[];
  /** The loading ripple runs from `rest` to `peak`; the idle ripple lifts bars toward `peak`. */
  rest: number[];
  peak: number[];
}

const DEFAULT_PALETTE: Palette = {
  idle: [63, 67, 74],
  note: [244, 243, 238],
  good: [46, 226, 122],
  bad: [255, 59, 47],
  rest: [37, 40, 45],
  peak: [210, 212, 208],
};

export interface Frame {
  /** dark: off, nothing shown. idle: grey bars only. loading: starting up. live: listening. */
  mode: 'dark' | 'idle' | 'loading' | 'live';
  time: number;
  note: Note | null;
  /** Smoothed distance from pitch. */
  cents: number;
  /** 0..1, how present the reading is: fades in on a note, out after it. */
  strength: number;
  /** Spot on: the whole arc lights green. */
  tuned: boolean;
  /** Width of spot on, in cents either side of pitch: the center bar's span. */
  spot: number;
  /** Close: the reading lights green, without the whole arc. True whenever `tuned` is. */
  close: boolean;
  /** 0..1, from the contrast dial. */
  brightness: number;
  /** 0..1, how settled the in-tune confirmation is. */
  lock: number;
}

interface Layout {
  cx: number;
  cy: number;
  radius: number;
  bar: number;
  barWidth: number;
  pitch: number;
  small: number;
  noteX: number;
  noteY: number;
  sideX: number;
}

const rgb = (color: number[], alpha: number) => `rgb(${color[0]} ${color[1]} ${color[2]} / ${alpha.toFixed(3)})`;
const mix = (from: number[], to: number[], t: number) => from.map((v, i) => Math.round(v + (to[i] - v) * t));

export class Reading {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bloom: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private layout: Layout | null = null;
  private palette = DEFAULT_PALETTE;

  constructor(canvas: HTMLCanvasElement, bloom: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.bloom = bloom.getContext('2d')!;
  }

  setPalette(palette: Palette) {
    this.palette = palette;
  }

  /** Height of the arc and note together, in CSS pixels. */
  get compositionHeight(): number {
    return this.layout ? this.layout.radius * COMPOSITION : 0;
  }

  /** Vertical center of the note, in CSS pixels, for text that takes its place. */
  get noteCenter(): number {
    return this.layout ? this.layout.noteY + (GLYPH_HEIGHT * this.layout.pitch) / 2 : 0;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ratio = window.devicePixelRatio || 1;
    this.ctx.canvas.width = Math.round(width * this.ratio);
    this.ctx.canvas.height = Math.round(height * this.ratio);
    // The glow is blurred anyway, so it renders at CSS resolution.
    this.bloom.canvas.width = Math.round(width);
    this.bloom.canvas.height = Math.round(height);
    this.layout = width && height ? layout(width, height) : null;
  }

  draw(frame: Frame) {
    const { ctx, bloom } = this;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    bloom.clearRect(0, 0, this.width, this.height);
    if (!this.layout || frame.mode === 'dark') return;

    this.gauge(this.layout, frame);
    if (frame.mode === 'live') this.note(this.layout, frame);

    bloom.drawImage(ctx.canvas, 0, 0, this.width, this.height);
  }

  private gauge(L: Layout, f: Frame) {
    // Spot on holds the reading on the center bar; close keeps it inside the center three.
    const P = this.palette;
    const exact = barFor(f.cents, f.spot);
    const position = f.tuned ? 0 : f.close ? Math.max(-1, Math.min(1, exact)) : exact;
    const loading = f.mode === 'loading';
    const off = loading ? P.rest : P.idle;
    const on = loading ? P.peak : f.close ? P.good : P.bad;
    // The confirmation only ever shows in green; leaving for red drops it at once.
    const lock = f.mode === 'live' && f.close ? f.lock : 0;

    for (let i = -HALF; i <= HALF; i++) {
      // `glow` is how much of the lit color a bar takes; `grow` how much longer it gets.
      let glow = 0;
      let grow = 0;
      // `rest` lifts a resting bar toward light grey: the idle ripple.
      let rest = 0;
      if (loading) {
        glow = ripple(f.time, i, RIPPLE_MS);
        grow = glow * 0.5;
      } else if (f.mode === 'live') {
        const distance = Math.abs(i - position);
        const here = Math.max(0, 1 - distance) * f.strength;
        const beside = Math.max(0, 1 - Math.abs(distance - 1)) * NEIGHBOR * f.strength;
        // Confirmation: the arc fills green from the center out.
        const fill = staggered(lock, (Math.abs(i) / HALF) * ARC_STAGGER) * f.strength;
        grow = here;
        glow = Math.max(here, beside, fill);
        rest = ripple(f.time, i, IDLE_RIPPLE_MS) * IDLE_RIPPLE_DEPTH * (1 - f.strength);
      }
      const length = L.bar * (i === 0 ? CENTER : 1) * (1 + GROW * grow);
      const width = L.barWidth * (i === 0 ? 1.2 : 1);
      const angle = (i / HALF) * SWEEP;
      const color = mix(mix(off, P.peak, rest), on, glow);
      this.bar(this.ctx, L, angle, length, width, rgb(color, f.brightness));
      // The five center bars glow brighter, center first. Drawn into the glow layer
      // only, so just the halo grows.
      if (lock > 0 && Math.abs(i) <= LOCK_GLOW_BARS) {
        const boost = staggered(lock, (Math.abs(i) / LOCK_GLOW_BARS) * GLOW_STAGGER) * LOCK_GLOW * f.brightness;
        if (boost > 0) this.bar(this.bloom, L, angle, length, width, rgb(P.good, boost));
      }
    }
  }

  private note(L: Layout, f: Frame) {
    if (!f.note || f.strength < 0.01) return;
    const alpha = f.strength * f.brightness;
    const { name, octave } = f.note;
    this.glyph(name.slice(0, 1), L.noteX, L.noteY, L.pitch, rgb(this.palette.note, alpha));
    this.glyph(name.slice(1), L.sideX, L.noteY, L.small, rgb(this.palette.note, alpha));
    this.glyph(String(octave), L.sideX, L.noteY + GLYPH_HEIGHT * (L.pitch - L.small), L.small, rgb(this.palette.note, alpha * 0.5));
  }

  /** One LED bar, standing on the arc and pointing out from its center. */
  private bar(ctx: CanvasRenderingContext2D, L: Layout, angle: number, length: number, width: number, color: string) {
    const inner = L.radius - L.bar / 2;
    ctx.save();
    ctx.translate(L.cx, L.cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.roundRect(-width / 2, -(inner + length), width, length, Math.min(2, width * 0.12));
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  /** Square pixels with a hint of rounding. Only lit pixels are drawn. */
  private glyph(char: string, x: number, y: number, pitch: number, color: string) {
    const { ctx } = this;
    const rows = glyph(char);
    const gap = pitch * 0.12;
    const side = pitch - gap;
    ctx.beginPath();
    for (let r = 0; r < GLYPH_HEIGHT; r++) {
      for (let c = 0; c < GLYPH_WIDTH; c++) {
        if (rows[r][c] === '#') ctx.roundRect(x + c * pitch + gap / 2, y + r * pitch + gap / 2, side, side, side * 0.1);
      }
    }
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/**
 * Bar position for a distance from pitch, in bars from center (signed). The center
 * bar covers ±`spot`¢, the next ones reach ±5¢, and the outer six cover the rest.
 */
function barFor(cents: number, spot: number): number {
  const c = Math.min(50, Math.abs(cents));
  let bar: number;
  if (c <= spot) bar = (c / spot) * 0.5;
  else if (c <= CLOSE_CENTS) bar = 0.5 + (c - spot) / (CLOSE_CENTS - spot);
  else bar = 1.5 + (HALF - 1.5) * ((c - CLOSE_CENTS) / (50 - CLOSE_CENTS)) ** OUTER_CURVE;
  return Math.sign(cents) * bar;
}

/** How far along a bar is when the whole effect is at `amount` (0..1), starting `delay` late. */
function staggered(amount: number, delay: number): number {
  return Math.max(0, Math.min(1, (amount - delay) / (1 - delay)));
}

/** 0..1 brightness of bar `i` in a wave radiating out from the center bar. */
function ripple(time: number, i: number, period: number): number {
  const phase = time / period - (Math.abs(i) / HALF) * RIPPLE_LAG;
  return (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)) ** 2;
}

/** Sizes the arc to the space, then sets the note inside it. */
function layout(width: number, height: number): Layout {
  // The composition is COMPOSITION radii tall and about 2.1 radii wide.
  const radius = Math.min(width * 0.44, (height - 24) / COMPOSITION);
  const bar = radius * 0.2;
  const pitch = radius * 0.19;
  const small = pitch * 0.38;
  const cx = width / 2;
  // Center what's visible at rest (arc tip to note foot) on the optical center, a
  // little above the true middle, while leaving room for the lit center bar on top
  // and the note's foot below.
  const restTop = radius - bar / 2 + bar * CENTER;
  const litTop = radius - bar / 2 + bar * CENTER * (1 + GROW);
  const foot = -radius * NOTE_DROP + GLYPH_HEIGHT * pitch;
  const optical = height * OPTICAL_CENTER + (restTop - foot) / 2;
  const cy = Math.min(height - MARGIN - foot, Math.max(MARGIN + litTop, optical));

  // The letter is centered on its own, so it lines up with the center bar and holds
  // still when a sharp comes and goes.
  return {
    cx,
    cy,
    radius,
    bar,
    barWidth: radius * 0.08,
    pitch,
    small,
    noteX: cx - (GLYPH_WIDTH * pitch) / 2,
    noteY: cy - radius * NOTE_DROP,
    sideX: cx + (GLYPH_WIDTH * pitch) / 2 + pitch * 0.35,
  };
}
