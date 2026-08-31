export const DOSBOX_CONFIG_MAX_LENGTH: number
export const DOSBOX_CONFIG_ALLOWED_SECTIONS: readonly string[]

export interface DosboxConfigEntry {
  section: string
  key: string
  value: string
  line: number
}

export function normalizeDosboxConfigOverride(input: unknown): string
export function parseDosboxConfigOverride(input: unknown): { entries: DosboxConfigEntry[] }
export function mergeDosboxConfigOverride(base: unknown, override: unknown): string
