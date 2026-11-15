/**
 * 8BitGo：javax.microedition.io 的最小替身。
 *
 * 备用运行时不提供联网（浏览器里也没有 J2ME 那种 socket），但有的游戏在 catch 子句或排行榜入口里
 * 引用这些类；类不存在时一加载就 NoClassDefFoundError，整局崩掉。这里让类存在、打开连接时抛
 * ConnectionNotFoundException（IOException 的子类），游戏按「没网」处理即可继续玩。
 */
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';

const noConnection = (t: JThread, url: unknown) => {
  throw t.jvm.throwable('javax/microedition/io/ConnectionNotFoundException', `networking is not available: ${String(url)}`);
};

const iface = (name: string, interfaces: string[] = []): NativeClassDef => ({ name, interfaces, flags: ACC_ABSTRACT | ACC_INTERFACE });

export const netStubNatives: NativeClassDef[] = [
  { name: 'javax/microedition/io/ConnectionNotFoundException', super: 'java/io/IOException' },
  // Connection / InputConnection 已在 media.ts 里定义，这里不重复（原生类表后注册的会覆盖先注册的）
  iface('javax/microedition/io/OutputConnection', ['javax/microedition/io/Connection']),
  iface('javax/microedition/io/StreamConnection', ['javax/microedition/io/InputConnection', 'javax/microedition/io/OutputConnection']),
  iface('javax/microedition/io/ContentConnection', ['javax/microedition/io/StreamConnection']),
  iface('javax/microedition/io/HttpConnection', ['javax/microedition/io/ContentConnection']),
  iface('javax/microedition/io/StreamConnectionNotifier', ['javax/microedition/io/Connection']),
  {
    name: 'javax/microedition/io/Connector',
    fields: { 'READ:I': 1, 'WRITE:I': 2, 'READ_WRITE:I': 3 },
    statics: {
      'open(Ljava/lang/String;)Ljavax/microedition/io/Connection;': (t, [url]) => noConnection(t, url),
      'open(Ljava/lang/String;I)Ljavax/microedition/io/Connection;': (t, [url]) => noConnection(t, url),
      'open(Ljava/lang/String;IZ)Ljavax/microedition/io/Connection;': (t, [url]) => noConnection(t, url),
      'openInputStream(Ljava/lang/String;)Ljava/io/InputStream;': (t, [url]) => noConnection(t, url),
      'openDataInputStream(Ljava/lang/String;)Ljava/io/DataInputStream;': (t, [url]) => noConnection(t, url),
      'openOutputStream(Ljava/lang/String;)Ljava/io/OutputStream;': (t, [url]) => noConnection(t, url),
      'openDataOutputStream(Ljava/lang/String;)Ljava/io/DataOutputStream;': (t, [url]) => noConnection(t, url),
    },
  },
];
