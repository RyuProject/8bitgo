import type { JThread, Jvm } from '../jvm/jvm';
import { commandForSoftKey } from '../jvm/natives/lcdui';
import { WAITING } from '../jvm/thread';
import { BLOCK, INVOKED, JObject, type JValue, type NativeResult } from '../jvm/types';
import { GraphicsPeer } from './graphics';
import { KEY_SOFT_LEFT, KEY_SOFT_RIGHT, gameActionOf } from './keys';
import type { Platform } from './platform';
import { type Surface, createSurface } from './surface';

export type KeyEventKind = 'pressed' | 'released' | 'repeated';
export type PointerEventKind = 'pressed' | 'released' | 'dragged';

export class DisplayService {
  current: JObject | null = null;
  readonly back: Surface;
  private displayObject: JObject | null = null;
  private graphics: JObject | null = null;
  private repaintPending = false;
  private paintQueued = false;
  private painting = false;
  /** Bitmask of game actions currently held / pressed since the last getKeyStates() (GameCanvas). */
  heldActions = 0;
  latchedActions = 0;

  constructor(private readonly platform: Platform) {
    this.back = createSurface(platform.config.width, platform.config.height, '#ffffff');
  }

  private get jvm(): Jvm {
    return this.platform.jvm;
  }

  get width(): number {
    return this.platform.config.width;
  }

  get height(): number {
    return this.platform.config.height;
  }

  isCanvas(obj: JObject | null): boolean {
    return obj !== null && this.jvm.isInstance(obj, 'javax/microedition/lcdui/Canvas');
  }

  displayFor(): JObject {
    if (!this.displayObject) {
      this.displayObject = new JObject(this.jvm.loadClass('javax/microedition/lcdui/Display'));
      this.displayObject.n = this;
    }
    return this.displayObject;
  }

  /** Graphics bound to the screen back buffer (reset before every paint). */
  screenGraphics(): JObject {
    if (!this.graphics) this.graphics = this.platform.newGraphics(this.back);
    (this.graphics.n as GraphicsPeer).reset();
    return this.graphics;
  }

  setCurrent(next: JObject | null): void {
    if (next === this.current) {
      if (next) this.requestRepaint();
      return;
    }
    const prev = this.current;
    // Alert 要记下被覆盖的对象，关闭时恢复（Alert 本身是唯一被画出来的 Displayable）
    if (next && this.jvm.isInstance(next, 'javax/microedition/lcdui/Alert')) {
      const ap = next.n as { prev?: JObject | null; timer?: ReturnType<typeof setTimeout> | null };
      ap.prev = prev;
      ap.timer = null;
      this.current = next;
      if (prev && this.isCanvas(prev)) this.callLater(prev, 'hideNotify()V', []);
      this.callLater(next, 'showNotify()V', []);
      return;
    }
    this.current = next;
    if (prev && this.isCanvas(prev)) this.callLater(prev, 'hideNotify()V', []);
    if (next && this.isCanvas(next)) {
      this.callLater(next, 'showNotify()V', []);
      this.requestRepaint();
    } else if (next) {
      this.platform.config.log('warn', `Screen-based UI (${next.cls.name}) is not supported yet`);
    }
  }

  /**
   * 关掉当前显示的 Alert，回到它覆盖的那个 Displayable。
   *
   * Alert 是本模拟器里唯一被真正画出来的非 Canvas Displayable，
   * 所以它不走 setCurrent 的 Screen 分支，而是在这里单独收尾：
   * 记下被覆盖的对象 → 恢复 current → 触发 hideNotify → 重绘。
   *
   * @param fromTimeout true 表示是 setTimeout 到点自动关（不再回传命令）。
   */
  dismissAlert(alert: JObject, fromTimeout: boolean): void {
    if (this.current !== alert) return;
    const peer = alert.n as { prev?: JObject | null; timer?: ReturnType<typeof setTimeout> | null } | null;
    if (peer?.timer) {
      clearTimeout(peer.timer);
      peer.timer = null;
    }
    const prev = peer?.prev ?? null;
    this.current = prev;
    if (prev) {
      if (this.isCanvas(prev)) {
        this.callLater(prev, 'showNotify()V', []);
        this.requestRepaint();
      }
    }
    if (!fromTimeout) {
      // 用户按键关掉时，按 MIDP 语义把选择结果回传给游戏
      const listener = prev?.n ? (prev.n as { listener?: JObject | null }).listener : null;
      if (listener) {
        const cmd = this.okCommand(listener);
        if (cmd) this.callLater(listener, 'commandAction(Ljavax/microedition/lcdui/Command;Ljavax/microedition/lcdui/Displayable;)V', [
          cmd,
          prev,
        ]);
      }
    }
  }

  /** 在命令监听器上找 OK 命令（Alert 按键关闭时按 MIDP 规范选它）。 */
  private okCommand(listener: JObject): JObject | null {
    const commands = (listener.n as { commands?: JObject[] } | null)?.commands ?? [];
    return commands.find((c) => (c.n as { type?: number }).type === 1 /* COMMAND_OK */) ?? null;
  }

  callLater(obj: JObject, key: string, args: JValue[]): void {
    const jvm = this.jvm;
    jvm.postEvent((t) => {
      const m = jvm.findVirtual(obj.cls, key);
      if (!m) return false;
      if (m.impl) {
        m.impl(t, [obj, ...args]);
        return false;
      }
      jvm.pushCall(t, m, [obj, ...args]);
      return true;
    });
  }

  requestRepaint(): void {
    this.repaintPending = true;
    if (this.paintQueued) return;
    this.paintQueued = true;
    this.jvm.postEvent((t) => {
      this.paintQueued = false;
      return this.startPaint(t);
    });
  }

  /** Pushes paint(Graphics) on `t`. Returns true when a Java frame was pushed. */
  private startPaint(t: JThread): boolean {
    if (!this.repaintPending || this.painting) return false;
    const canvas = this.current;
    this.repaintPending = false;
    if (!canvas || !this.isCanvas(canvas)) return false;
    const jvm = this.jvm;
    const paint = jvm.findVirtual(canvas.cls, 'paint(Ljavax/microedition/lcdui/Graphics;)V');
    if (!paint) return false;
    this.painting = true;
    jvm.pushCall(t, paint, [canvas, this.screenGraphics()], () => {
      this.painting = false;
      this.present();
      jvm.wake();
    });
    return paint.impl === null;
  }

  serviceRepaints(t: JThread): NativeResult {
    if (!this.repaintPending && !this.painting) return;
    if (t.isEventThread) {
      if (this.painting) return;
      return this.startPaint(t) ? INVOKED : undefined;
    }
    t.state = WAITING;
    t.condition = () => !this.repaintPending && !this.painting;
    this.jvm.wake();
    return BLOCK;
  }

  present(): void {
    this.platform.config.present(this.back);
  }

  postKey(kind: KeyEventKind, code: number): void {
    const action = gameActionOf(code);
    if (action) {
      const bit = 1 << action;
      if (kind === 'pressed') {
        this.heldActions |= bit;
        this.latchedActions |= bit;
      } else if (kind === 'released') {
        this.heldActions &= ~bit;
      }
    }
    const jvm = this.jvm;
    const current = this.current;
    if ((code === KEY_SOFT_LEFT || code === KEY_SOFT_RIGHT) && current) {
      const command = commandForSoftKey(current, code);
      if (command) {
        if (kind === 'pressed') {
          const listener = (current.n as { listener: JObject }).listener;
          jvm.postEvent((t) => {
            const m = jvm.findVirtual(listener.cls, 'commandAction(Ljavax/microedition/lcdui/Command;Ljavax/microedition/lcdui/Displayable;)V');
            if (!m || m.impl) return false;
            jvm.pushCall(t, m, [listener, command, current]);
            return true;
          });
        }
        return;
      }
    }
    const key = kind === 'pressed' ? 'keyPressed(I)V' : kind === 'released' ? 'keyReleased(I)V' : 'keyRepeated(I)V';
    // Alert 处于前台时，按键只用来关掉对话框，不派发给游戏
    if (kind === 'pressed' && this.current && this.jvm.isInstance(this.current, 'javax/microedition/lcdui/Alert')) {
      this.dismissAlert(this.current, false);
      return;
    }
    jvm.postEvent((t) => {
      const canvas = this.current;
      if (!canvas || !this.isCanvas(canvas)) return false;
      const m = jvm.findVirtual(canvas.cls, key);
      if (!m || m.impl) return false;
      jvm.pushCall(t, m, [canvas, code]);
      return true;
    });
  }

  postPointer(kind: PointerEventKind, x: number, y: number): void {
    const jvm = this.jvm;
    const key = kind === 'pressed' ? 'pointerPressed(II)V' : kind === 'released' ? 'pointerReleased(II)V' : 'pointerDragged(II)V';
    jvm.postEvent((t) => {
      const canvas = this.current;
      if (!canvas || !this.isCanvas(canvas)) return false;
      const m = jvm.findVirtual(canvas.cls, key);
      if (!m || m.impl) return false;
      jvm.pushCall(t, m, [canvas, x, y]);
      return true;
    });
  }

  consumeKeyStates(): number {
    const states = this.heldActions | this.latchedActions;
    this.latchedActions = 0;
    return states;
  }
}
