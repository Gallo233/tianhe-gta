import * as THREE from 'three';

/**
 * Keyboard + mouse (pointer lock or drag) + touch intents.
 * Game code reads intents once per frame; edge-triggered actions are consumed with take*().
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly look = new THREE.Vector2();
  private zoomDelta = 0;
  private jumpQueued = false;
  private switchQueued: number | 'next' | null = null;
  private interactQueued = false;
  /** E: talk / use (orders, metro); F: vehicles. E alone near a vehicle with nothing else to do still works it. */
  private talkQueued = false;
  private digitQueued: number | null = null;
  private readonly pressed = new Set<string>();
  private weatherQueued = false;
  private helpQueued = false;
  private brainToggleQueued = false;
  private walkToggle = false;
  private dragging = false;
  private readonly touchMove = new THREE.Vector2();
  private touchSprint = false;
  private touchJumpHeld = false;
  private stickId: number | null = null;
  private stickCenter = new THREE.Vector2();
  private lookTouchId: number | null = null;
  private lastLookTouch = new THREE.Vector2();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    sprintBtn: HTMLElement,
    jumpBtn: HTMLElement,
    switchBtn: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    stick.addEventListener('pointerdown', this.onStickDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerdown', this.onCanvasTouch);
    sprintBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.touchSprint = true; });
    sprintBtn.addEventListener('pointerup', () => { this.touchSprint = false; });
    sprintBtn.addEventListener('pointerleave', () => { this.touchSprint = false; });
    jumpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.jumpQueued = true; this.touchJumpHeld = true; });
    jumpBtn.addEventListener('pointerup', () => { this.touchJumpHeld = false; });
    jumpBtn.addEventListener('pointerleave', () => { this.touchJumpHeld = false; });
    switchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.switchQueued = 'next'; });
    document.querySelector('#car-button')?.addEventListener('pointerdown', (e) => { e.preventDefault(); this.interactQueued = true; });
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (!this.pointerLocked && matchMedia('(pointer: fine)').matches) {
      // returns a promise in current browsers; a refused lock (iframe, no gesture) just means drag-to-look
      Promise.resolve(this.canvas.requestPointerLock?.()).catch(() => {});
    }
  }

  /** x = strafe right, y = forward. */
  readMove(target: THREE.Vector2): THREE.Vector2 {
    target.set(0, 0);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) target.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) target.x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) target.y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) target.y -= 1;
    target.add(this.touchMove);
    if (target.lengthSq() > 1) target.normalize();
    return target;
  }

  held(code: string): boolean {
    return this.keys.has(code);
  }

  /** Space, or the touch jump button held down while driving. */
  get handbrake(): boolean {
    return this.keys.has('Space') || this.touchJumpHeld;
  }

  sprintHeld(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
  }

  walking(): boolean {
    return this.walkToggle !== (this.keys.has('AltLeft') || this.keys.has('ControlLeft'));
  }

  takeLook(target: THREE.Vector2): THREE.Vector2 {
    target.copy(this.look);
    this.look.set(0, 0);
    return target;
  }

  takeZoom(): number {
    const z = this.zoomDelta;
    this.zoomDelta = 0;
    return z;
  }

  takeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  takeSwitch(): number | 'next' | null {
    const s = this.switchQueued;
    this.switchQueued = null;
    return s;
  }

  takeWeather(): boolean {
    const w = this.weatherQueued;
    this.weatherQueued = false;
    return w;
  }

  takeTalk(): boolean {
    const t = this.talkQueued;
    this.talkQueued = false;
    return t;
  }

  /** 1-4 pressed this frame (0-based), for dialogue choices. */
  takeDigit(): number | null {
    const d = this.digitQueued;
    this.digitQueued = null;
    return d;
  }

  /** Any key, edge-triggered (Escape for the photo mode). */
  takeKey(code: string): boolean {
    const k = this.pressed.has(code);
    this.pressed.delete(code);
    return k;
  }

  takeInteract(): boolean {
    const i = this.interactQueued;
    this.interactQueued = false;
    return i;
  }

  takeBrainToggle(): boolean {
    const b = this.brainToggleQueued;
    this.brainToggleQueued = false;
    return b;
  }

  takeHelp(): boolean {
    const h = this.helpQueued;
    this.helpQueued = false;
    return h;
  }

  /** Test/bot hook: hold keys programmatically. */
  setKey(code: string, down: boolean): void {
    if (down) this.onKeyDown(new KeyboardEvent('keydown', { code }));
    else this.onKeyUp(new KeyboardEvent('keyup', { code }));
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'Space') { this.jumpQueued = true; e.preventDefault?.(); }
    if (e.code === 'Digit1') this.switchQueued = 0;
    if (e.code === 'Digit2') this.switchQueued = 1;
    if (e.code === 'Digit3') this.switchQueued = 2;
    if (e.code === 'Tab') { this.switchQueued = 'next'; e.preventDefault?.(); }
    if (e.code === 'KeyF') this.interactQueued = true;
    if (e.code === 'KeyE') this.talkQueued = true;
    const dg = /^Digit([1-4])$/.exec(e.code);
    if (dg) this.digitQueued = Number(dg[1]) - 1;
    this.pressed.add(e.code);
    if (e.code === 'KeyH') this.helpQueued = true;
    if (e.code === 'KeyJ') this.brainToggleQueued = true;
    if (e.code === 'KeyR') this.weatherQueued = true;
    if (e.code === 'KeyC') this.walkToggle = !this.walkToggle;
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.touchSprint = false;
    this.touchJumpHeld = false;
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (e.button === 0 && matchMedia('(pointer: fine)').matches) this.requestLock();
    this.dragging = true;
  };

  private readonly onMouseUp = () => {
    this.dragging = false;
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (this.pointerLocked || (this.dragging && e.buttons & 2)) {
      this.look.x += e.movementX;
      this.look.y += e.movementY;
    }
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomDelta += Math.sign(e.deltaY);
  };

  private readonly onStickDown = (e: PointerEvent) => {
    e.preventDefault();
    const r = this.stick.getBoundingClientRect();
    this.stickId = e.pointerId;
    this.stickCenter.set(r.left + r.width / 2, r.top + r.height / 2);
    this.updateStick(e.clientX, e.clientY, r.width * 0.42);
  };

  private readonly onCanvasTouch = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || this.lookTouchId !== null) return;
    this.lookTouchId = e.pointerId;
    this.lastLookTouch.set(e.clientX, e.clientY);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      const r = this.stick.getBoundingClientRect();
      this.updateStick(e.clientX, e.clientY, r.width * 0.42);
    } else if (e.pointerId === this.lookTouchId) {
      this.look.x += (e.clientX - this.lastLookTouch.x) * 1.6;
      this.look.y += (e.clientY - this.lastLookTouch.y) * 1.6;
      this.lastLookTouch.set(e.clientX, e.clientY);
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.touchMove.set(0, 0);
      this.knob.style.transform = 'translate(-50%, -50%)';
    }
    if (e.pointerId === this.lookTouchId) this.lookTouchId = null;
  };

  private updateStick(x: number, y: number, radius: number): void {
    const dx = (x - this.stickCenter.x) / radius;
    const dy = (y - this.stickCenter.y) / radius;
    this.touchMove.set(dx, -dy);
    if (this.touchMove.lengthSq() > 1) this.touchMove.normalize();
    this.knob.style.transform = `translate(calc(-50% + ${this.touchMove.x * 38}px), calc(-50% + ${-this.touchMove.y * 38}px))`;
  }
}
