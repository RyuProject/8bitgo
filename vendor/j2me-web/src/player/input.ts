import {
  KEY_DOWN,
  KEY_LEFT,
  KEY_NUM2,
  KEY_NUM4,
  KEY_NUM6,
  KEY_NUM8,
  KEY_RIGHT,
  KEY_UP,
} from '../platform/keys';
import type { KeyEventKind } from '../platform/display';

export interface Chord {
  /** Phone key that must be held... */
  held: number;
  /** ...when this phone key is pressed... */
  pressed: number;
  /** ...to send this key instead. */
  send: number;
}

export interface InputOptions {
  /**
   * Many J2ME games only remember the last pressed key and forget movement when any key is released.
   * When enabled, still-held direction keys are pressed again after another key is released.
   */
  repressHeldDirections: boolean;
  chords: Chord[];
}

const DIRECTIONS = new Set([KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_NUM2, KEY_NUM4, KEY_NUM6, KEY_NUM8]);

interface Held {
  source: string;
  /** Key the source is bound to. */
  code: number;
  /** Key actually sent to the game (may differ because of a chord). */
  sent: number;
}

/** Merges keyboard, touch and gamepad input into phone key events. */
export class InputManager {
  private held: Held[] = [];

  constructor(
    private readonly send: (kind: KeyEventKind, code: number) => void,
    private readonly options: InputOptions,
  ) {}

  press(source: string, code: number): void {
    const existing = this.held.find((h) => h.source === source);
    if (existing) {
      this.send('repeated', existing.sent);
      return;
    }
    const chord = this.options.chords.find((c) => c.pressed === code && this.held.some((h) => h.sent === c.held));
    const sent = chord ? chord.send : code;
    const alreadyDown = this.held.some((h) => h.sent === sent);
    this.held.push({ source, code, sent });
    if (!alreadyDown) this.send('pressed', sent);
  }

  release(source: string): void {
    const index = this.held.findIndex((h) => h.source === source);
    if (index < 0) return;
    const [released] = this.held.splice(index, 1);
    if (this.held.some((h) => h.sent === released.sent)) return;
    this.send('released', released.sent);

    if (this.options.repressHeldDirections && !DIRECTIONS.has(released.sent)) {
      for (let i = this.held.length - 1; i >= 0; i--) {
        if (DIRECTIONS.has(this.held[i].sent)) {
          this.send('pressed', this.held[i].sent);
          break;
        }
      }
    }
  }

  releaseAll(prefix = ''): void {
    for (const h of [...this.held]) if (h.source.startsWith(prefix)) this.release(h.source);
  }

  isHeld(source: string): boolean {
    return this.held.some((h) => h.source === source);
  }
}
