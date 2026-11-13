import { KEY_DOWN, KEY_FIRE, KEY_LEFT, KEY_NUM0, KEY_RIGHT, KEY_SOFT_LEFT, KEY_SOFT_RIGHT, KEY_UP } from '../platform/keys';
import type { InputManager } from './input';
import type { GamePreset } from './presets';

/** Polls the Gamepad API (standard mapping) and feeds phone keys into the input manager. */
export class GamepadInput {
  private frame = 0;
  private readonly state = new Map<string, boolean>();

  constructor(
    private readonly input: InputManager,
    preset: GamePreset,
  ) {
    const actions = preset.touchActions ?? [];
    this.buttons = {
      0: actions[0]?.code ?? KEY_FIRE,
      1: actions[1]?.code ?? KEY_SOFT_RIGHT,
      2: actions[2]?.code ?? KEY_SOFT_LEFT,
      3: actions[3]?.code ?? KEY_NUM0,
      4: KEY_SOFT_LEFT,
      5: KEY_SOFT_RIGHT,
      6: actions[4]?.code ?? KEY_NUM0,
      7: KEY_FIRE,
      8: KEY_SOFT_RIGHT,
      9: KEY_SOFT_LEFT,
      12: KEY_UP,
      13: KEY_DOWN,
      14: KEY_LEFT,
      15: KEY_RIGHT,
    };
    this.frame = requestAnimationFrame(this.poll);
  }

  private readonly buttons: Record<number, number>;

  private readonly poll = () => {
    this.frame = requestAnimationFrame(this.poll);
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      for (const [index, code] of Object.entries(this.buttons)) {
        this.update(`pad:${pad.index}:b${index}`, code, !!pad.buttons[Number(index)]?.pressed);
      }
      const [x = 0, y = 0] = pad.axes;
      this.update(`pad:${pad.index}:ax-left`, KEY_LEFT, x < -0.5);
      this.update(`pad:${pad.index}:ax-right`, KEY_RIGHT, x > 0.5);
      this.update(`pad:${pad.index}:ax-up`, KEY_UP, y < -0.5);
      this.update(`pad:${pad.index}:ax-down`, KEY_DOWN, y > 0.5);
    }
  };

  private update(source: string, code: number, pressed: boolean): void {
    if ((this.state.get(source) ?? false) === pressed) return;
    this.state.set(source, pressed);
    if (pressed) this.input.press(source, code);
    else this.input.release(source);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.input.releaseAll('pad:');
  }
}
