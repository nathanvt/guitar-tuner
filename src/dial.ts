// A rotary dial: printed scale, fixed knob, rotating pointer. Turn it by dragging up or
// right (down or left turns it back), or with the arrow keys. A stepped dial clicks
// between detents, and a tap on it steps to the next one.

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The pointer sweeps 270°, from 7:30 to 4:30. */
const START = -135;
const RANGE = 270;
/** Pixels of drag for a full turn. */
const TRAVEL = 220;

export interface DialOptions {
  /** Scale printed at each tick; a stepped dial has one detent per entry. */
  scale: string[];
  /** Continuous dials take any value 0..1 between ticks; stepped ones only the ticks. */
  stepped: boolean;
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

  private get steps() {
    return this.options.scale.length - 1;
  }

  private set(next: number) {
    const clamped = Math.min(1, Math.max(0, next));
    const value = this.options.stepped ? Math.round(clamped * this.steps) / this.steps : clamped;
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
    let moved = false;

    this.root.addEventListener('pointerdown', (event) => {
      this.root.setPointerCapture(event.pointerId);
      this.root.classList.add('turning');
      start = { x: event.clientX, y: event.clientY, value: this.value };
      moved = false;
    });
    this.root.addEventListener('pointermove', (event) => {
      if (!start) return;
      const travel = start.y - event.clientY + (event.clientX - start.x);
      if (Math.abs(travel) > 4) moved = true;
      if (moved) this.set(start.value + travel / TRAVEL);
    });
    const end = () => {
      if (start && !moved && this.options.stepped) {
        // A tap steps to the next detent, wrapping back to the first.
        this.set(this.value >= 1 ? 0 : this.value + 1 / this.steps);
      }
      start = null;
      this.root.classList.remove('turning');
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);

    this.root.addEventListener('keydown', (event) => {
      const step = this.options.stepped ? 1 / this.steps : 0.05;
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
    const { scale, stepped } = this.options;
    const ticks = stepped ? this.steps : 20;
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks;
      const angle = ((START + t * RANGE) * Math.PI) / 180;
      const major = stepped || i % 2 === 0;
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
    scale.forEach((label, i) => {
      if (!label) return;
      const angle = ((START + (i / (scale.length - 1)) * RANGE) * Math.PI) / 180;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', (55 * Math.sin(angle)).toFixed(2));
      text.setAttribute('y', (-55 * Math.cos(angle) + 2.5).toFixed(2));
      text.textContent = label;
      svg.append(text);
    });
  }
}
