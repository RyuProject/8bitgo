import type { InputManager } from '../player/input';
import type { GamePreset } from '../player/presets';
import { KEY_DOWN, KEY_FIRE, KEY_LEFT, KEY_POUND, KEY_RIGHT, KEY_SOFT_LEFT, KEY_SOFT_RIGHT, KEY_STAR, KEY_UP } from '../platform/keys';
import { h } from './dom';

function buzz() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* unsupported */
  }
}

/** On-screen phone controls: d-pad + soft keys on the left, actions + keypad on the right. */
export class TouchControls {
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  readonly keypad: HTMLElement;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly input: InputManager,
    preset: GamePreset,
  ) {
    const dpad = h(
      'div',
      { class: 'dpad', attrs: { 'aria-label': '摇杆' } },
      h('span', { class: 'dpad-arrow up' }),
      h('span', { class: 'dpad-arrow right' }),
      h('span', { class: 'dpad-arrow down' }),
      h('span', { class: 'dpad-arrow left' }),
    );
    this.bindDpad(dpad);

    this.keypad = h(
      'div',
      { class: 'keypad', attrs: { hidden: '' } },
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((label) =>
        this.button(label, label === '*' ? KEY_STAR : label === '#' ? KEY_POUND : label.charCodeAt(0), 'key'),
      ),
    );
    const keypadToggle = h('button', {
      class: 'touch-btn small',
      text: '123',
      attrs: { 'aria-label': '数字键盘' },
      on: {
        click: () => {
          this.keypad.toggleAttribute('hidden');
          keypadToggle.classList.toggle('active', !this.keypad.hasAttribute('hidden'));
        },
      },
    });

    const actions = preset.touchActions?.length ? preset.touchActions : [{ label: 'OK', code: KEY_FIRE }];

    this.left = h(
      'div',
      { class: 'touch-panel touch-left' },
      h('div', { class: 'touch-row' }, this.button('◀ 软键', KEY_SOFT_LEFT, 'soft'), keypadToggle),
      dpad,
    );
    this.right = h(
      'div',
      { class: 'touch-panel touch-right' },
      h('div', { class: 'touch-row end' }, this.button('软键 ▶', KEY_SOFT_RIGHT, 'soft')),
      h('div', { class: `actions count-${Math.min(actions.length, 5)}` }, ...actions.map((a, i) => this.button(a.label, a.code, i === 0 ? 'action primary' : 'action'))),
    );
  }

  private button(label: string, code: number, kind: string): HTMLElement {
    const btn = h('button', { class: `touch-btn ${kind}`, text: label, attrs: { 'data-code': String(code), type: 'button' } });
    return btn;
  }

  /** Buttons: press on touch, slide between buttons, release on lift. */
  bindButtons(root: HTMLElement): void {
    const active = new Map<number, HTMLElement>();
    const sourceFor = (pointerId: number, el: HTMLElement) => `touch:${pointerId}:${el.dataset.code}`;

    const target = (e: PointerEvent): HTMLElement | null =>
      (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-code]') as HTMLElement | null) ?? null;

    const set = (e: PointerEvent, el: HTMLElement | null) => {
      const prev = active.get(e.pointerId) ?? null;
      if (prev === el) return;
      if (prev) {
        prev.classList.remove('pressed');
        this.input.release(sourceFor(e.pointerId, prev));
        active.delete(e.pointerId);
      }
      if (el && root.contains(el)) {
        el.classList.add('pressed');
        this.input.press(sourceFor(e.pointerId, el), Number(el.dataset.code));
        active.set(e.pointerId, el);
        buzz();
      }
    };

    const down = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest('[data-code]') as HTMLElement | null;
      if (!el) return;
      e.preventDefault();
      root.setPointerCapture?.(e.pointerId);
      set(e, el);
    };
    const move = (e: PointerEvent) => {
      if (active.has(e.pointerId)) set(e, target(e));
    };
    const up = (e: PointerEvent) => set(e, null);

    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cleanups.push(() => {
      for (const [pointerId, el] of active) this.input.release(sourceFor(pointerId, el));
      active.clear();
    });
  }

  private bindDpad(dpad: HTMLElement): void {
    const active = new Map<number, Set<number>>();
    const apply = (pointerId: number, next: Set<number>) => {
      const prev = active.get(pointerId) ?? new Set<number>();
      for (const code of prev) if (!next.has(code)) this.input.release(`dpad:${pointerId}:${code}`);
      for (const code of next) if (!prev.has(code)) this.input.press(`dpad:${pointerId}:${code}`, code);
      if (next.size && [...next].some((c) => !prev.has(c))) buzz();
      active.set(pointerId, next);
      dpad.dataset.dir = [...new Set([...active.values()].flatMap((s) => [...s]))].join(' ');
    };
    const directions = (e: PointerEvent): Set<number> => {
      const rect = dpad.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const dead = rect.width * 0.14;
      const out = new Set<number>();
      if (Math.hypot(dx, dy) < dead) return out;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = right, 90 = down
      if (angle > -67.5 && angle < 67.5) out.add(KEY_RIGHT);
      if (angle > 22.5 && angle < 157.5) out.add(KEY_DOWN);
      if (angle > 112.5 || angle < -112.5) out.add(KEY_LEFT);
      if (angle > -157.5 && angle < -22.5) out.add(KEY_UP);
      return out;
    };
    dpad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dpad.setPointerCapture?.(e.pointerId);
      apply(e.pointerId, directions(e));
    });
    dpad.addEventListener('pointermove', (e) => {
      if (active.has(e.pointerId)) apply(e.pointerId, directions(e));
    });
    const end = (e: PointerEvent) => {
      apply(e.pointerId, new Set());
      active.delete(e.pointerId);
    };
    dpad.addEventListener('pointerup', end);
    dpad.addEventListener('pointercancel', end);
    dpad.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cleanups.push(() => {
      for (const pointerId of [...active.keys()]) apply(pointerId, new Set());
      active.clear();
    });
  }

  mount(): void {
    this.bindButtons(this.left);
    this.bindButtons(this.right);
    this.bindButtons(this.keypad);
  }

  destroy(): void {
    for (const fn of this.cleanups) fn();
    this.left.remove();
    this.right.remove();
    this.keypad.remove();
  }
}
