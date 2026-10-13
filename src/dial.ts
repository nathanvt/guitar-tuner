// A rotary dial: printed scale, fixed knob, rotating pointer. Turn it by dragging up or
// right (down or left turns it back), or with the arrow keys. With `steps`, it clicks
// between detents.

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The pointer sweeps 270°, from 7:30 to 4:30. */
const START = -135;
const RANGE = 270;
/** Pixels of drag for a full turn. */
const TRAVEL = 220;
const TICKS = 20;

export interface DialOptions {
  /** Numbers printed evenly around the scale; empty strings leave a gap. '0' is printed bold. */
  scale: string[];
  /** Detents between the ends; omit for a smooth dial. */
  steps?: number;
  /** 0..1 */
  value: number;
  describe: (value: number) => string;
  onChange: (value: number) => void;
}

export class Dial {
  private readonly root: HTMLElement;
  private readonly pointer: HTMLElement;
  private readonly options: DialOptions;
  private value: number;

  constructor(root: HTMLElement, options: DialOptions) {
    this.root = root;
    this.pointer = root.querySelector<HTMLElement>('.pointer')!;
    this.options = options;
    this.value = options.value;
    this.printScale(root.querySelector<SVGSVGElement>('.dial-scale')!);
    this.listen();
    this.show();
  }

  private set(next: number) {
    const { steps } = this.options;
    const clamped = Math.min(1, Math.max(0, next));
    const value = steps ? Math.round(clamped * steps) / steps : clamped;
    if (value === this.value) return;
    this.value = value;
    this.show();
    this.options.onChange(value);
  }

  private show() {
    this.pointer.style.transform = `rotate(${START + this.value * RANGE}deg)`;
    this.root.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
    this.root.setAttribute('aria-valuetext', this.options.describe(this.value));
  }

  private listen() {
    let start: { x: number; y: number; value: number } | null = null;

    this.root.addEventListener('pointerdown', (event) => {
      this.root.setPointerCapture(event.pointerId);
      this.root.classList.add('turning');
      start = { x: event.clientX, y: event.clientY, value: this.value };
    });
    this.root.addEventListener('pointermove', (event) => {
      if (!start) return;
      this.set(start.value + (start.y - event.clientY + (event.clientX - start.x)) / TRAVEL);
    });
    const end = () => {
      start = null;
      this.root.classList.remove('turning');
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);

    this.root.addEventListener('keydown', (event) => {
      const step = this.options.steps ? 1 / this.options.steps : 0.05;
      const moves: Record<string, number> = {
        ArrowUp: this.value + step,
        ArrowRight: this.value + step,
        ArrowDown: this.value - step,
        ArrowLeft: this.value - step,
        Home: 0,
        End: 1,
      };
      if (!(event.key in moves)) return;
      event.preventDefault();
      this.set(moves[event.key]);
    });
  }

  /** Ticks and numbers around the knob, like a printed panel. */
  private printScale(svg: SVGSVGElement) {
    const ticks = this.options.steps ?? TICKS;
    for (let i = 0; i <= ticks; i++) {
      const angle = ((START + (i / ticks) * RANGE) * Math.PI) / 180;
      const major = this.options.steps !== undefined || i % 2 === 0;
      const outer = 46;
      const inner = major ? 40 : 43;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', (inner * Math.sin(angle)).toFixed(2));
      line.setAttribute('y1', (-inner * Math.cos(angle)).toFixed(2));
      line.setAttribute('x2', (outer * Math.sin(angle)).toFixed(2));
      line.setAttribute('y2', (-outer * Math.cos(angle)).toFixed(2));
      line.setAttribute('class', major ? 'tick major' : 'tick');
      svg.append(line);
    }
    const { scale } = this.options;
    scale.forEach((label, i) => {
      if (!label) return;
      const angle = ((START + (i / (scale.length - 1)) * RANGE) * Math.PI) / 180;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', (55 * Math.sin(angle)).toFixed(2));
      text.setAttribute('y', (-55 * Math.cos(angle) + 2.5).toFixed(2));
      text.textContent = label;
      if (label === '0') text.setAttribute('class', 'home');
      svg.append(text);
    });
  }
}
