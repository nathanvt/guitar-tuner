import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from './pixelfont.ts';
import type { Note } from './pitch.ts';

/*
  The reading, on open space: an arc of LED bars above a white pixel note.
    - Bars rest grey. The bar at the current pitch lights red and grows longer, so
      both color and size carry the reading. In tune, the whole arc lights green.
    - Between two bars, the light splits across both, so the reading glides.
    - Nothing is drawn where nothing is lit.
    - The note letter sits dead center, under the center bar, and never moves; the
      sharp and octave hang off its right side.
*/

/** Bars on each side of the center bar. */
const HALF = 8;
/** The arc spans ±60° from straight up, leaving room for the note's side column below its ends. */
const SWEEP = (60 * Math.PI) / 180;
/** How much longer a fully lit bar grows; the center bar is the target and always longer. */
const GROW = 0.4;
const CENTER = 1.25;
/** Height of the whole composition, arc to note, in radii. */
const COMPOSITION = 2.26;

const IDLE = [63, 67, 74];
const RED = [255, 59, 47];
const GREEN = [46, 226, 122];
const SWEEP_LIGHT = [210, 212, 208];
const WHITE = [244, 243, 238];

export interface Frame {
  /** dark: off, nothing shown. sweep: starting up. live: listening. */
  mode: 'dark' | 'sweep' | 'live';
  time: number;
  note: Note | null;
  /** Smoothed distance from pitch. */
  cents: number;
  /** 0..1, how present the reading is: fades in on a note, out after it. */
  strength: number;
  tuned: boolean;
  /** 0..1, from the brightness dial. */
  brightness: number;
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

  constructor(canvas: HTMLCanvasElement, bloom: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.bloom = bloom.getContext('2d')!;
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
    const position = Math.max(-HALF, Math.min(HALF, (f.cents / 50) * HALF));
    // While starting, a light runs along the arc.
    const head = ((f.time / 900) % 1) * (2 * HALF + 6) - HALF - 3;
    const on = f.mode === 'sweep' ? SWEEP_LIGHT : f.tuned ? GREEN : RED;

    for (let i = -HALF; i <= HALF; i++) {
      // `glow` is how much of the lit color a bar takes; `grow` how much longer it gets.
      let glow = 0;
      let grow = 0;
      if (f.mode === 'sweep') {
        glow = grow = Math.max(0, 1 - Math.abs(i - head) / 1.5);
      } else {
        const here = Math.max(0, 1 - Math.abs(i - position)) * f.strength;
        grow = f.tuned && i === 0 ? f.strength : here;
        glow = f.tuned ? f.strength : here;
      }
      const length = L.bar * (i === 0 ? CENTER : 1) * (1 + GROW * grow);
      const width = L.barWidth * (i === 0 ? 1.2 : 1);
      this.bar(L, (i / HALF) * SWEEP, length, width, rgb(mix(IDLE, on, glow), f.brightness));
    }
  }

  private note(L: Layout, f: Frame) {
    if (!f.note || f.strength < 0.01) return;
    const alpha = f.strength * f.brightness;
    const { name, octave } = f.note;
    this.glyph(name.slice(0, 1), L.noteX, L.noteY, L.pitch, rgb(WHITE, alpha));
    this.glyph(name.slice(1), L.sideX, L.noteY, L.small, rgb(WHITE, alpha));
    this.glyph(String(octave), L.sideX, L.noteY + GLYPH_HEIGHT * (L.pitch - L.small), L.small, rgb(WHITE, alpha * 0.5));
  }

  /** One LED bar, standing on the arc and pointing out from its center. */
  private bar(L: Layout, angle: number, length: number, width: number, color: string) {
    const { ctx } = this;
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

/** Sizes the arc to the space, then sets the note inside it. */
function layout(width: number, height: number): Layout {
  // The composition is COMPOSITION radii tall and about 2.1 radii wide.
  const radius = Math.min(width * 0.44, (height - 24) / COMPOSITION);
  const bar = radius * 0.2;
  const pitch = radius * 0.19;
  const small = pitch * 0.38;
  // The tallest mark is the lit center bar.
  const reach = radius - bar / 2 + bar * CENTER * (1 + GROW);
  const top = (height - radius * COMPOSITION) / 2;
  const cx = width / 2;
  const cy = top + reach;

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
    noteY: cy - radius * 0.3,
    sideX: cx + (GLYPH_WIDTH * pitch) / 2 + pitch * 0.35,
  };
}
