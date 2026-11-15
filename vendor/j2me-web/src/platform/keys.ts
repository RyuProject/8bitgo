// MIDP key codes as used by Nokia / Samsung / Sony Ericsson handsets.
export const KEY_NUM0 = 48;
export const KEY_NUM1 = 49;
export const KEY_NUM2 = 50;
export const KEY_NUM3 = 51;
export const KEY_NUM4 = 52;
export const KEY_NUM5 = 53;
export const KEY_NUM6 = 54;
export const KEY_NUM7 = 55;
export const KEY_NUM8 = 56;
export const KEY_NUM9 = 57;
export const KEY_STAR = 42;
export const KEY_POUND = 35;
export const KEY_UP = -1;
export const KEY_DOWN = -2;
export const KEY_LEFT = -3;
export const KEY_RIGHT = -4;
export const KEY_FIRE = -5;
export const KEY_SOFT_LEFT = -6;
export const KEY_SOFT_RIGHT = -7;
export const KEY_CLEAR = -8;

export const GAME_UP = 1;
export const GAME_LEFT = 2;
export const GAME_RIGHT = 5;
export const GAME_DOWN = 6;
export const GAME_FIRE = 8;
export const GAME_A = 9;
export const GAME_B = 10;
export const GAME_C = 11;
export const GAME_D = 12;

export function gameActionOf(code: number): number {
  switch (code) {
    case KEY_UP:
    case KEY_NUM2:
      return GAME_UP;
    case KEY_DOWN:
    case KEY_NUM8:
      return GAME_DOWN;
    case KEY_LEFT:
    case KEY_NUM4:
      return GAME_LEFT;
    case KEY_RIGHT:
    case KEY_NUM6:
      return GAME_RIGHT;
    case KEY_FIRE:
    case KEY_NUM5:
      return GAME_FIRE;
    case KEY_NUM1:
      return GAME_A;
    case KEY_NUM3:
      return GAME_B;
    case KEY_NUM7:
      return GAME_C;
    case KEY_NUM9:
      return GAME_D;
    default:
      return 0;
  }
}

export function keyCodeOf(action: number): number {
  switch (action) {
    case GAME_UP:
      return KEY_UP;
    case GAME_DOWN:
      return KEY_DOWN;
    case GAME_LEFT:
      return KEY_LEFT;
    case GAME_RIGHT:
      return KEY_RIGHT;
    case GAME_FIRE:
      return KEY_FIRE;
    case GAME_A:
      return KEY_NUM1;
    case GAME_B:
      return KEY_NUM3;
    case GAME_C:
      return KEY_NUM7;
    case GAME_D:
      return KEY_NUM9;
    default:
      return 0;
  }
}

export function keyName(code: number): string {
  if (code >= KEY_NUM0 && code <= KEY_NUM9) return String.fromCharCode(code);
  switch (code) {
    case KEY_STAR:
      return '*';
    case KEY_POUND:
      return '#';
    case KEY_UP:
      return 'Up';
    case KEY_DOWN:
      return 'Down';
    case KEY_LEFT:
      return 'Left';
    case KEY_RIGHT:
      return 'Right';
    case KEY_FIRE:
      return 'Select';
    case KEY_SOFT_LEFT:
      return 'Soft1';
    case KEY_SOFT_RIGHT:
      return 'Soft2';
    case KEY_CLEAR:
      return 'Clear';
    default:
      return code > 0 ? String.fromCharCode(code) : `Key ${code}`;
  }
}
