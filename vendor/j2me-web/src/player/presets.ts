import type { ScreenSize } from './detect';
import type { Chord } from './input';

export interface TouchButton {
  label: string;
  code: number;
}

/** Optional per-game tweaks. Only compatibility metadata, never game content. */
export interface GamePreset {
  screen?: ScreenSize;
  /** Extra KeyboardEvent.code → phone key bindings. */
  keys?: Record<string, number>;
  keyHelp?: Array<[string, string]>;
  /** Big action buttons shown next to the d-pad on touch screens. */
  touchActions?: TouchButton[];
  chords?: Chord[];
  repressHeldDirections?: boolean;
}

interface PresetEntry {
  name: string;
  vendor?: string;
  preset: GamePreset;
}

const PRESETS: PresetEntry[] = [
  {
    name: 'Forgotten Warrior',
    preset: {
      screen: { width: 176, height: 220 },
      keys: { KeyZ: 53, KeyX: 50, KeyA: 55, KeyS: 57, KeyD: 48 },
      keyHelp: [
        ['←/→ 或 4/6', '行走'],
        ['X 或 2', '跳跃（跑动时向移动方向跳）'],
        ['Z 或 5', '攻击'],
        ['A 或 7', 'HP 药'],
        ['S 或 9', 'MP 药'],
        ['D 或 0', '必杀技'],
        ['↑/↓', '楼梯和洞穴'],
      ],
      touchActions: [
        { label: '攻击', code: 53 },
        { label: '跳跃', code: 50 },
        { label: 'HP', code: 55 },
        { label: 'MP', code: 57 },
        { label: '必杀', code: 48 },
      ],
      chords: [
        { held: -3, pressed: 50, send: 49 },
        { held: -4, pressed: 50, send: 51 },
        { held: 52, pressed: 50, send: 49 },
        { held: 54, pressed: 50, send: 51 },
      ],
      repressHeldDirections: true,
    },
  },
];

export function findPreset(name: string, vendor: string): GamePreset {
  const entry = PRESETS.find((p) => p.name === name && (!p.vendor || p.vendor === vendor));
  return entry?.preset ?? {};
}
