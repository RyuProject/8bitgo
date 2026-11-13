import { GamePlayer } from './player/player';
import { DEFAULT_KEYMAP, physicalCode } from './player/keymap';
import { InputManager } from './player/input';
import type { PackIdentity } from './player/pack';
import { TouchControls } from './ui/touch';
import './ui/styles.css';
import './embed.css';

interface StartMessage {
  source: '8bitgo-j2me';
  type: 'start';
  jarUrl: string;
  fileName: string;
  storageId: string;
}

type ParentMessage =
  | { source: '8bitgo-j2me-web'; type: 'ready' }
  | { source: '8bitgo-j2me-web'; type: 'error'; message: string }
  | { source: '8bitgo-j2me-web'; type: 'log'; level: string; message: string };

const app = document.querySelector<HTMLElement>('#app')!;
const maxJarBytes = 64 * 1024 * 1024;
let player: GamePlayer | null = null;
let input: InputManager | null = null;
let touch: TouchControls | null = null;
let started = false;

function prefersTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
}

function notify(message: ParentMessage): void {
  if (window.parent === window) return;
  window.parent.postMessage(message, window.location.origin);
}

/**
 * 解压前先看 ZIP 中央目录，避免损坏包或高膨胀率压缩包一次占满浏览器内存。
 * JAR 是 ZIP；此兜底会把类文件展开到内存，必须限制压缩前后体积。
 */
function assertSafeJarArchive(data: Uint8Array): void {
  const maxExpandedBytes = 128 * 1024 * 1024;
  const maxEntries = 12_000;
  if (data.byteLength > maxJarBytes) throw new Error('JAR 超过备用运行时的 64 MiB 上限');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scanStart = Math.max(0, data.byteLength - 65_557);
  let endRecord = -1;
  for (let offset = data.byteLength - 22; offset >= scanStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) throw new Error('JAR 缺少 ZIP 目录');

  const disk = view.getUint16(endRecord + 4, true);
  const directoryDisk = view.getUint16(endRecord + 6, true);
  const diskEntries = view.getUint16(endRecord + 8, true);
  const entryCount = view.getUint16(endRecord + 10, true);
  const directoryBytes = view.getUint32(endRecord + 12, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  const commentBytes = view.getUint16(endRecord + 20, true);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount) throw new Error('不支持分卷 JAR');
  if (entryCount === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 JAR');
  }
  if (entryCount > maxEntries || endRecord + 22 + commentBytes > data.byteLength || directoryOffset + directoryBytes > endRecord) {
    throw new Error('JAR 的 ZIP 目录无效或过大');
  }

  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryOffset + directoryBytes || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('JAR 的 ZIP 目录损坏');
    }
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const entryCommentBytes = view.getUint16(offset + 32, true);
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) throw new Error('不支持 ZIP64 JAR');
    expandedBytes += uncompressedBytes;
    if (expandedBytes > maxExpandedBytes) throw new Error('JAR 解压后超过备用运行时的 128 MiB 上限');
    offset += 46 + nameBytes + extraBytes + entryCommentBytes;
  }
  if (offset > directoryOffset + directoryBytes) throw new Error('JAR 的 ZIP 目录长度无效');
}

async function readJarResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxJarBytes) {
    throw new Error('JAR 超过备用运行时的 64 MiB 上限');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式读取 JAR');

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxJarBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('JAR 超过备用运行时的 64 MiB 上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function start(message: StartMessage): Promise<void> {
  if (started) return;
  started = true;
  try {
    const url = new URL(message.jarUrl, window.location.href);
    if (url.origin !== window.location.origin) throw new Error('备用运行时只允许读取本站 JAR 代理');

    const response = await fetch(url, { credentials: 'same-origin', cache: 'default' });
    if (!response.ok) throw new Error(`游戏文件读取失败（HTTP ${response.status}）`);
    const bytes = await readJarResponse(response);
    assertSafeJarArchive(bytes);

    const packedWindow = window as unknown as {
      __PACK__?: { identity?: PackIdentity };
    };
    packedWindow.__PACK__ = { identity: { storageId: message.storageId } };

    const game = new GamePlayer(bytes, message.fileName, {
      onLog: (level, text) => notify({ source: '8bitgo-j2me-web', type: 'log', level, message: text }),
      onHalt: (reason, text) => {
        if (reason === 'error') {
          notify({ source: '8bitgo-j2me-web', type: 'error', message: text || 'J2ME 游戏运行失败' });
        }
      },
    });
    player = game;
    const canvas = game.screen;
    canvas.id = 'display';
    canvas.tabIndex = 0;

    input = new InputManager((kind, code) => game.key(kind, code), {
      repressHeldDirections: game.preset.repressHeldDirections ?? false,
      chords: game.preset.chords ?? [],
    });
    touch = new TouchControls(input, game.preset);
    const view = document.createElement('main');
    view.className = 'player';
    const titlebar = document.createElement('header');
    titlebar.className = 'player-bar';
    const title = document.createElement('div');
    title.className = 'player-title';
    title.textContent = game.info.name;
    titlebar.append(title);
    const stage = document.createElement('section');
    stage.className = 'player-stage';
    stage.append(canvas, touch.keypad);
    view.append(titlebar, touch.left, stage, touch.right);
    app.replaceChildren(view);
    touch.mount();
    view.classList.toggle('touch', prefersTouch());

    const resize = () => {
      const scale = Math.min(stage.clientWidth / canvas.width, stage.clientHeight / canvas.height);
      canvas.style.width = `${Math.max(1, canvas.width * scale)}px`;
      canvas.style.height = `${Math.max(1, canvas.height * scale)}px`;
    };
    window.addEventListener('resize', resize);
    resize();

    const onKeyDown = (event: KeyboardEvent) => {
      const physical = physicalCode(event);
      const code = DEFAULT_KEYMAP[physical];
      if (code === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      input?.press(`kb:${physical}`, code);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const physical = physicalCode(event);
      const manager = input;
      if (!manager?.isHeld(`kb:${physical}`)) return;
      event.preventDefault();
      manager.release(`kb:${physical}`);
    };
    const onBlur = () => input?.releaseAll('kb:');
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      touch?.destroy();
      touch = null;
      input?.releaseAll();
      player?.stop();
    }, { once: true });

    await game.prepareImages().catch((error: unknown) => {
      console.warn('[j2me-web] JPEG 预解码失败：', error);
    });
    game.start();
    canvas.focus({ preventScroll: true });
    notify({ source: '8bitgo-j2me-web', type: 'ready' });
  } catch (error) {
    started = false;
    const messageText = error instanceof Error ? error.message : String(error);
    notify({ source: '8bitgo-j2me-web', type: 'error', message: messageText });
  }
}

window.addEventListener('message', (event: MessageEvent<StartMessage>) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.source !== '8bitgo-j2me' || event.data.type !== 'start') return;
  void start(event.data);
});
