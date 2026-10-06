import { reportError } from './ErrorReport';

export class Loop {
  private frameId = 0;
  private lastTime = 0;
  private running = false;

  constructor(
    private readonly update: (deltaSeconds: number, elapsedSeconds: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number) => {
    if (!this.running) return;
    // never below 0: the first frame's timestamp (the start of that frame) can be a few ms before the
    // performance.now() taken in start() -- a negative dt sent MallSigns to SCREEN[-1] and froze the game in Chrome 154
    const deltaSeconds = Math.max(0, Math.min((time - this.lastTime) / 1000, 0.05));
    this.lastTime = time;
    // schedule first: a frame that throws is reported and the next one still runs (it used to end the loop)
    this.frameId = requestAnimationFrame(this.tick);
    try {
      this.update(deltaSeconds, time / 1000);
      this.render();
    } catch (err) {
      reportError('帧', err);
    }
  };
}
