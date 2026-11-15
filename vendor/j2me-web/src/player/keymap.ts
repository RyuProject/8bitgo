import {
  KEY_CLEAR,
  KEY_DOWN,
  KEY_FIRE,
  KEY_LEFT,
  KEY_POUND,
  KEY_RIGHT,
  KEY_SOFT_LEFT,
  KEY_SOFT_RIGHT,
  KEY_STAR,
  KEY_UP,
} from '../platform/keys';

/** KeyboardEvent.code → MIDP key code. Uses physical keys, so it works with any keyboard layout. */
export type KeyMap = Record<string, number>;

export const DEFAULT_KEYMAP: KeyMap = {
  ArrowUp: KEY_UP,
  ArrowDown: KEY_DOWN,
  ArrowLeft: KEY_LEFT,
  ArrowRight: KEY_RIGHT,
  Enter: KEY_FIRE,
  NumpadEnter: KEY_FIRE,
  Space: KEY_FIRE,
  F1: KEY_SOFT_LEFT,
  KeyQ: KEY_SOFT_LEFT,
  F2: KEY_SOFT_RIGHT,
  KeyE: KEY_SOFT_RIGHT,
  Backspace: KEY_CLEAR,
  NumpadMultiply: KEY_STAR,
  NumpadDivide: KEY_POUND,
  Minus: KEY_STAR,
  Equal: KEY_POUND,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, 48 + i])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, 48 + i])),
};

const KEY_TO_CODE: Record<string, string> = {
  Enter: 'Enter',
  ' ': 'Space',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Backspace: 'Backspace',
  F1: 'F1',
  F2: 'F2',
  '*': 'NumpadMultiply',
  '#': 'NumpadDivide',
};

/** Physical key code; falls back to `key` for keyboards/browsers that leave `code` empty. */
export function physicalCode(e: KeyboardEvent): string {
  if (e.code) return e.code;
  if (KEY_TO_CODE[e.key]) return KEY_TO_CODE[e.key];
  if (/^\d$/.test(e.key)) return `Digit${e.key}`;
  if (/^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
  return '';
}

export const KEY_HELP: Array<[string, string]> = [
  ['方向键', '摇杆'],
  ['Enter / 空格', '中键（确定）'],
  ['F1 或 Q', '左软键'],
  ['F2 或 E', '右软键'],
  ['0–9', '手机数字键'],
  ['− / =', '* 和 #'],
  ['Backspace', '清除（C）'],
];
