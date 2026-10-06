/**
 * Conversations: a panel at the bottom of the screen with who is speaking (name, role, colour), the line typed out,
 * and numbered choices. Scripts are data (arrays of steps), run synchronously from the game loop, so the QA suite
 * can drive them frame by frame:
 *
 *   { say, who }          a line (who = a speaker key; omitted = the narrator); E / Space / click: finish typing, next
 *   { choose: [...] }     1 / 2 / 3 / 4 or click; each option's `then` steps run next; options with `if` false are hidden
 *   { run }               a side effect; may return steps to run next (branching on game state)
 *   { pause }             the panel hides for n seconds (someone walks over, time passes)
 *
 * While a conversation is open the player cannot move (the world and the order's clock keep running).
 */
export interface Speaker { name: string; role?: string; color: string }
export type Step =
  | { say: string; who?: string }
  | { choose: { text: string; then?: Step[]; if?: () => boolean }[] }
  | { run: () => void | Step[] | null }
  | { pause: number };

const el = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

export class Dialogue {
  private readonly root = el<HTMLElement>('#dialog');
  private readonly whoName = el<HTMLElement>('#dialog-name');
  private readonly whoRole = el<HTMLElement>('#dialog-role');
  private readonly badge = el<HTMLElement>('#dialog-badge');
  private readonly text = el<HTMLElement>('#dialog-text');
  private readonly choices = el<HTMLElement>('#dialog-choices');
  private readonly hint = el<HTMLElement>('#dialog-hint');
  private stack: { steps: Step[]; i: number }[] = [];
  private typed = 0;
  private line = '';
  private pauseT = 0;
  private options: { text: string; then?: Step[] }[] | null = null;
  private clicked: number | null = null;
  private onEnd: (() => void) | null = null;
  /** the line being shown (tests read it) */
  current: { who: string; text: string } | null = null;
  /** everything said in the current conversation (tests, the phone's chat log) */
  readonly log: string[] = [];
  /** called for every line as it appears, for every choice taken, and when the panel closes (the game's voices) */
  onLine: (who: string, text: string) => void = () => {};
  onChoice: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(private readonly speakers: Record<string, Speaker>) {
    this.choices.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li?.dataset.i) { e.preventDefault(); this.clicked = Number(li.dataset.i); }
    });
    this.root.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('li')) this.clicked = -1; });
  }

  get open(): boolean { return this.stack.length > 0; }
  /** a narration that does not stop the player (story intros and epilogues): they keep riding, E pages through */
  blocking = true;
  get choosing(): boolean { return this.options !== null; }

  /** Start a conversation (replaces one in progress). */
  play(steps: Step[], onEnd?: () => void, blocking = true): void {
    this.blocking = blocking || steps.some((s) => 'choose' in s);
    this.root.classList.toggle('free', !this.blocking);
    this.stack = [{ steps, i: 0 }];
    this.onEnd = onEnd ?? null;
    this.log.length = 0;
    this.options = null;
    this.next();
  }

  /** Register (or override) a speaker at run time: shop staff, customers. */
  speaker(key: string, s: Speaker): void { this.speakers[key] = s; }

  /** Per frame. advance: E / Space pressed; choice: 1-4 pressed (0-based) or null. */
  update(dt: number, advance: boolean, choice: number | null): void {
    if (!this.open) return;
    if (this.clicked !== null) { if (this.clicked >= 0) choice = this.clicked; else advance = true; this.clicked = null; }
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      if (this.pauseT <= 0) this.next();
      return;
    }
    if (this.options) {
      if (choice !== null && choice >= 0 && choice < this.options.length) {
        const o = this.options[choice];
        this.log.push(`> ${o.text}`);
        this.onChoice(o.text);
        this.options = null;
        this.choices.innerHTML = '';
        if (o.then?.length) this.stack.push({ steps: o.then, i: 0 });
        this.next();
      }
      return;
    }
    if (this.typed < this.line.length) {
      this.typed = advance ? this.line.length : Math.min(this.line.length, this.typed + dt * 42);
      this.text.textContent = this.line.slice(0, Math.floor(this.typed));
      if (this.typed >= this.line.length) this.hint.hidden = false;
      return;
    }
    if (advance) this.next();
  }

  /** Skip to the end of the current line (tests). */
  finishLine(): void { this.typed = this.line.length; this.text.textContent = this.line; }

  private next(): void {
    for (;;) {
      const top = this.stack[this.stack.length - 1];
      if (!top) { this.close(); return; }
      if (top.i >= top.steps.length) { this.stack.pop(); continue; }
      const s = top.steps[top.i++];
      if ('say' in s) { this.show(s.who ?? '', s.say); return; }
      if ('pause' in s) { this.root.hidden = true; this.pauseT = s.pause; return; }
      if ('run' in s) {
        const more = s.run();
        if (Array.isArray(more) && more.length) this.stack.push({ steps: more, i: 0 });
        if (!this.stack.length) { this.close(); return; }
        continue;
      }
      if ('choose' in s) {
        const opts = s.choose.filter((o) => !o.if || o.if());
        if (!opts.length) continue;
        this.options = opts;
        this.root.hidden = false;
        this.hint.hidden = true;
        this.choices.innerHTML = opts.map((o, i) => `<li data-i="${i}"><kbd>${i + 1}</kbd>${o.text}</li>`).join('');
        return;
      }
    }
  }

  private show(who: string, text: string): void {
    const sp = this.speakers[who] ?? { name: '', color: '#8e959c' };
    this.root.hidden = false;
    this.root.classList.toggle('narration', !sp.name);
    this.whoName.textContent = sp.name;
    this.whoRole.textContent = sp.role ?? '';
    this.badge.textContent = sp.name ? sp.name[0] : '';
    this.badge.style.background = sp.color;
    this.line = text;
    this.typed = 0;
    this.text.textContent = '';
    this.hint.hidden = true;
    this.choices.innerHTML = '';
    this.current = { who, text };
    this.log.push(`${sp.name || '·'}：${text}`);
    this.onLine(who, text);
  }

  private close(): void {
    this.onClose();
    this.root.hidden = true;
    this.stack = [];
    this.options = null;
    this.current = null;
    const f = this.onEnd;
    this.onEnd = null;
    f?.();
  }

  /** Abort (the player got on a train, was busted...). */
  cancel(): void { this.onEnd = null; this.close(); }
}
