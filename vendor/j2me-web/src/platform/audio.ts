export const CLIP_MMF = 1;
export const CLIP_MP3 = 2;
export const CLIP_MIDI = 3;

export interface AudioClipHandle {
  play(loops: number, volume: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

/**
 * Audio backend. Stage 1 is silent: formats are recognised so games run, playback comes later.
 */
export class AudioService {
  private readonly warned = new Set<string>();
  muted = false;

  constructor(private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void) {}

  createClip(type: number, data: Uint8Array): AudioClipHandle {
    const format = type === CLIP_MMF ? 'MMF (SMAF)' : type === CLIP_MP3 ? 'MP3' : type === CLIP_MIDI ? 'MIDI' : `type ${type}`;
    if (!this.warned.has(format)) {
      this.warned.add(format);
      this.log('info', `Audio clip format ${format} (${data.length} bytes) is not playable yet`);
    }
    return { play() {}, pause() {}, resume() {}, stop() {} };
  }
}
