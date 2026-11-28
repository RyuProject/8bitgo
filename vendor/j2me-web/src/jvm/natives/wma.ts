/**
 * 8BitGo：WMA 2.0 的类路径兼容层。
 *
 * 备用 JVM 没有手机短信服务。保留这些 API 类型，是为了让只在联网分支引用 WMA 的游戏
 * 能先进入自己的异常处理；实际 Connector.open 仍由 netstub 明确报 ConnectionNotFoundException。
 * 这里不模拟发送成功、接收空消息或伪造短信功能。
 */
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';
import { JArray, JObject } from '../types';
import { newByteArrayInputStream, readAllBytes } from './io';

function unavailableMessaging(t: JThread): never {
  throw t.jvm.throwable('javax/microedition/io/ConnectionNotFoundException', 'wireless messaging is unavailable in the browser fallback');
}

const wmaInterface = (name: string, interfaces: string[] = []): NativeClassDef => ({
  name,
  interfaces,
  flags: ACC_ABSTRACT | ACC_INTERFACE,
});

export const wmaNatives: NativeClassDef[] = [
  wmaInterface('javax/wireless/messaging/Message'),
  wmaInterface('javax/wireless/messaging/TextMessage', ['javax/wireless/messaging/Message']),
  wmaInterface('javax/wireless/messaging/BinaryMessage', ['javax/wireless/messaging/Message']),
  wmaInterface('javax/wireless/messaging/MultipartMessage', ['javax/wireless/messaging/Message']),
  wmaInterface('javax/wireless/messaging/MessageListener'),
  {
    name: 'javax/wireless/messaging/MessageConnection',
    interfaces: ['javax/microedition/io/Connection'],
    flags: ACC_ABSTRACT | ACC_INTERFACE,
    // javac 会把接口常量内联进多数游戏；保留字段是为了反射和未内联字节码仍能正常解析。
    fields: {
      'BINARY_MESSAGE:Ljava/lang/String;': 'binary',
      'MULTIPART_MESSAGE:Ljava/lang/String;': 'multipart',
      'TEXT_MESSAGE:Ljava/lang/String;': 'text',
    },
    methods: {
      'newMessage(Ljava/lang/String;)Ljavax/wireless/messaging/Message;': (t) => unavailableMessaging(t),
      'newMessage(Ljava/lang/String;Ljava/lang/String;)Ljavax/wireless/messaging/Message;': (t) => unavailableMessaging(t),
      'numberOfSegments(Ljavax/wireless/messaging/Message;)I': (t) => unavailableMessaging(t),
      'receive()Ljavax/wireless/messaging/Message;': (t) => unavailableMessaging(t),
      'send(Ljavax/wireless/messaging/Message;)V': (t) => unavailableMessaging(t),
      'setMessageListener(Ljavax/wireless/messaging/MessageListener;)V': (t) => unavailableMessaging(t),
    },
  },
  {
    name: 'javax/wireless/messaging/MessagePart',
    methods: {
      '<init>([BLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (t, [self, content, mimeType, contentId, contentLocation, encoding]) => {
        initializePart(t, self, content, 0, content instanceof JArray ? content.d.length : 0, mimeType, contentId, contentLocation, encoding);
      },
      '<init>([BIILjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (t, [self, content, offset, length, mimeType, contentId, contentLocation, encoding]) => {
        initializePart(t, self, content, offset, length, mimeType, contentId, contentLocation, encoding);
      },
      '<init>(Ljava/io/InputStream;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (t, [self, stream, mimeType, contentId, contentLocation, encoding]) => {
        if (stream === null) throw t.jvm.npe();
        const content = readAllBytes(t, stream);
        initializePart(t, self, content, 0, content.length, mimeType, contentId, contentLocation, encoding);
      },
      'getContent()[B': (_t, [self]) => {
        const bytes = part(self).content;
        return bytes === null ? null : new JArray('[B', bytes.slice());
      },
      'getContentAsStream()Ljava/io/InputStream;': (t, [self]) => newByteArrayInputStream(t.jvm, part(self).content ?? new Uint8Array()),
      'getContentID()Ljava/lang/String;': (_t, [self]) => part(self).contentId,
      'getContentLocation()Ljava/lang/String;': (_t, [self]) => part(self).contentLocation,
      'getEncoding()Ljava/lang/String;': (_t, [self]) => part(self).encoding,
      'getLength()I': (_t, [self]) => part(self).content?.length ?? 0,
      'getMIMEType()Ljava/lang/String;': (_t, [self]) => part(self).mimeType,
    },
  },
];

interface MessagePartPeer {
  content: Int8Array | null;
  mimeType: string;
  contentId: string;
  contentLocation: string | null;
  encoding: string | null;
}

function part(self: JObject): MessagePartPeer {
  return self.n as MessagePartPeer;
}

function initializePart(
  t: JThread,
  self: JObject,
  content: JArray | Uint8Array | null,
  offset: number,
  length: number,
  mimeType: string | null,
  contentId: string | null,
  contentLocation: string | null,
  encoding: string | null,
): void {
  if (mimeType === null || contentId === null) throw t.jvm.throwable('java/lang/IllegalArgumentException');
  const source = content instanceof JArray ? content.d as Int8Array : content instanceof Uint8Array ? content : null;
  if (source === null) {
    if (offset !== 0 || length > 0) throw t.jvm.throwable('java/lang/IllegalArgumentException');
  } else if (offset < 0 || length < 0 || offset + length > source.length) {
    throw t.jvm.throwable('java/lang/IllegalArgumentException');
  }
  self.n = {
    content: source === null ? null : source.slice(offset, offset + length),
    mimeType,
    contentId,
    contentLocation,
    encoding,
  } satisfies MessagePartPeer;
}
