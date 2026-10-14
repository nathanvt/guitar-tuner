// The mic grille: drilled holes over the phone's microphone. Light shines through
// them from the bottom up in proportion to the input level, like a peak meter.

const PITCH = 9;
const HOLE = 1.7;

export class Grille {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private cols = 0;
  private rows = 0;
  private shown = -1;
  private level = 0;
  private glow = 6;
  private colors = { bore: '#060708', lip: 'rgb(255 255 255 / 0.07)', lit: [244, 241, 232] };

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ratio = window.devicePixelRatio || 1;
    this.ctx.canvas.width = Math.round(width * this.ratio);
    this.ctx.canvas.height = Math.round(height * this.ratio);
    this.cols = Math.floor(width / PITCH);
    this.rows = Math.floor(height / PITCH);
    this.redraw();
  }

  /** The holes, their lit lower lip, and the light that shines through them. */
  setColors(colors: { bore: string; lip: string; lit: number[] }) {
    this.colors = colors;
    this.redraw();
  }

  /** Blur, in pixels, of the light around lit holes. */
  setGlow(pixels: number) {
    this.glow = pixels;
    this.redraw();
  }

  /** `level` is 0..1. Redraws only when a whole row changes. */
  draw(level: number) {
    this.level = level;
    const lit = Math.round(level * this.rows);
    if (lit === this.shown) return;
    this.shown = lit;

    const { ctx } = this;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const left = (this.width - (this.cols - 1) * PITCH) / 2;
    const top = (this.height - (this.rows - 1) * PITCH) / 2;

    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        const x = left + c * PITCH;
        const y = top + r * PITCH;
        const height = this.rows - 1 - r; // 0 is the bottom row
        if (height < lit) {
          const [r, g, b] = this.colors.lit;
          ctx.shadowColor = `rgb(${r} ${g} ${b} / 0.8)`;
          ctx.shadowBlur = this.glow;
          this.hole(x, y, `rgb(${r} ${g} ${b} / ${(0.5 + (0.4 * height) / this.rows).toFixed(3)})`);
          ctx.shadowBlur = 0;
        } else {
          // A dark bore with a faint lit lower lip.
          this.hole(x, y + 0.6, this.colors.lip);
          this.hole(x, y, this.colors.bore);
        }
      }
    }
  }

  private redraw() {
    this.shown = -1;
    this.draw(this.level);
  }

  private hole(x: number, y: number, color: string) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, HOLE, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }
}
