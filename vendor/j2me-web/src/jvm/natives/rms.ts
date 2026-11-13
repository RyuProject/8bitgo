import type { Platform } from '../../platform/platform';
import type { StoreData } from '../../platform/rms';
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';
import { JArray, JObject, type JRef } from '../types';
import { checkArrayRange } from './helpers';

interface StorePeer {
  name: string;
  data: StoreData;
  openCount: number;
  listeners: JObject[];
}

const opened = new WeakMap<Platform, Map<string, JObject>>();

function platform(t: JThread): Platform {
  return t.jvm.platform as Platform;
}

function openStores(t: JThread): Map<string, JObject> {
  const p = platform(t);
  let map = opened.get(p);
  if (!map) opened.set(p, (map = new Map()));
  return map;
}

function store(t: JThread, self: JObject): StorePeer {
  const peer = self.n as StorePeer;
  if (peer.openCount <= 0) throw t.jvm.throwable('javax/microedition/rms/RecordStoreNotOpenException');
  return peer;
}

function persist(t: JThread, peer: StorePeer) {
  peer.data.version++;
  peer.data.lastModified = Date.now();
  platform(t).rms.save(peer.name, peer.data);
}

function recordOrThrow(t: JThread, peer: StorePeer, id: number): Uint8Array {
  const rec = peer.data.records.get(id);
  if (!rec) throw t.jvm.throwable('javax/microedition/rms/InvalidRecordIDException', String(id));
  return rec;
}

function notifyListeners(t: JThread, self: JObject, key: string, id: number) {
  for (const l of (self.n as StorePeer).listeners) t.jvm.callVirtualSync(t, l, key, [self, id]);
}

function open(t: JThread, name: string | null, create: boolean): JObject {
  const jvm = t.jvm;
  if (name === null) throw jvm.npe();
  if (name.length < 1 || name.length > 32) throw jvm.throwable('java/lang/IllegalArgumentException', 'Invalid record store name');
  const stores = openStores(t);
  const existing = stores.get(name);
  if (existing) {
    (existing.n as StorePeer).openCount++;
    return existing;
  }
  let data = platform(t).rms.load(name);
  if (!data) {
    if (!create) throw jvm.throwable('javax/microedition/rms/RecordStoreNotFoundException', name);
    data = { nextId: 1, version: 0, lastModified: Date.now(), records: new Map() };
    platform(t).rms.save(name, data);
  }
  const obj = new JObject(jvm.loadClass('javax/microedition/rms/RecordStore'));
  obj.n = { name, data, openCount: 1, listeners: [] } satisfies StorePeer;
  stores.set(name, obj);
  return obj;
}

function toBytes(t: JThread, arr: JArray | null, off: number, len: number): Uint8Array {
  if (arr === null) {
    if (len > 0) throw t.jvm.npe();
    return new Uint8Array(0);
  }
  checkArrayRange(t.jvm, arr, off, len);
  const d = arr.d as Int8Array;
  return new Uint8Array(d.buffer, d.byteOffset + off, len).slice();
}

function toJavaBytes(bytes: Uint8Array): JArray {
  return new JArray('[B', new Int8Array(bytes.slice().buffer));
}

const recordStoreClass: NativeClassDef = {
  name: 'javax/microedition/rms/RecordStore',
  fields: { 'AUTHMODE_PRIVATE:I': 0, 'AUTHMODE_ANY:I': 1 },
  statics: {
    'openRecordStore(Ljava/lang/String;Z)Ljavax/microedition/rms/RecordStore;': (t, [name, create]) => open(t, name, !!create),
    'openRecordStore(Ljava/lang/String;ZIZ)Ljavax/microedition/rms/RecordStore;': (t, [name, create]) => open(t, name, !!create),
    'openRecordStore(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljavax/microedition/rms/RecordStore;': (t, [name]) =>
      open(t, name, false),
    'deleteRecordStore(Ljava/lang/String;)V': (t, [name]) => {
      const jvm = t.jvm;
      if (name === null) throw jvm.npe();
      const stores = openStores(t);
      if (stores.has(name) && (stores.get(name)!.n as StorePeer).openCount > 0) {
        throw jvm.throwable('javax/microedition/rms/RecordStoreException', 'Record store is open');
      }
      if (!platform(t).rms.load(name)) throw jvm.throwable('javax/microedition/rms/RecordStoreNotFoundException', name);
      stores.delete(name);
      platform(t).rms.delete(name);
    },
    'listRecordStores()[Ljava/lang/String;': (t) => {
      const names = platform(t).rms.list();
      return names.length ? new JArray('[Ljava/lang/String;', names) : null;
    },
  },
  methods: {
    // MIDP 里 closeRecordStore(String) 是 RecordStore 的静态方法，
    // 实例关闭方法是 close()。两个都要有：只实现其中一个，
    // 游戏调另一个就会 AbstractMethodError（实测踩过）。
    'closeRecordStore(Ljava/lang/String;)V': (t, [name]) => {
      const obj = openStores(t).get(name);
      if (!obj) return;
      (obj.n as StorePeer).openCount = 0;
      obj.n = { ...(obj.n as StorePeer), listeners: [] } satisfies StorePeer;
      openStores(t).delete(name);
    },
    'close()V': (t, [self]) => {
      const peer = store(t, self);
      if (--peer.openCount === 0) {
        peer.listeners = [];
        openStores(t).delete(peer.name);
      }
    },
    // 兼容早期 MIDP 1.0 里被误当实例方法的写法
    'closeRecordStore()V': (t, [self]) => {
      const peer = store(t, self);
      if (--peer.openCount === 0) {
        peer.listeners = [];
        openStores(t).delete(peer.name);
      }
    },
    'getName()Ljava/lang/String;': (t, [self]) => store(t, self).name,
    'getVersion()I': (t, [self]) => store(t, self).data.version,
    'getLastModified()J': (t, [self]) => BigInt(store(t, self).data.lastModified),
    'getNumRecords()I': (t, [self]) => store(t, self).data.records.size,
    'getNextRecordID()I': (t, [self]) => store(t, self).data.nextId,
    'getSize()I': (t, [self]) => [...store(t, self).data.records.values()].reduce((n, r) => n + r.length + 8, 64),
    'getSizeAvailable()I': () => 512 * 1024,
    'addRecord([BII)I': (t, [self, data, off, len]) => {
      const peer = store(t, self);
      const id = peer.data.nextId++;
      peer.data.records.set(id, toBytes(t, data, off, len));
      persist(t, peer);
      notifyListeners(t, self, 'recordAdded(Ljavax/microedition/rms/RecordStore;I)V', id);
      return id;
    },
    'setRecord(I[BII)V': (t, [self, id, data, off, len]) => {
      const peer = store(t, self);
      // MIDP 规范：setRecord 是「新建或覆盖」，记录不存在时必须创建。
      // 之前这里调 recordOrThrow 会抛 InvalidRecordIDException，
      // 导致「写新存档」直接失败（仙剑就是这样存的）。
      const existed = peer.data.records.has(id);
      peer.data.records.set(id, toBytes(t, data, off, len));
      persist(t, peer);
      notifyListeners(
        t,
        self,
        existed ? 'recordChanged(Ljavax/microedition/rms/RecordStore;I)V' : 'recordAdded(Ljavax/microedition/rms/RecordStore;I)V',
        id,
      );
    },
    'deleteRecord(I)V': (t, [self, id]) => {
      const peer = store(t, self);
      recordOrThrow(t, peer, id);
      peer.data.records.delete(id);
      persist(t, peer);
      notifyListeners(t, self, 'recordDeleted(Ljavax/microedition/rms/RecordStore;I)V', id);
    },
    'getRecordSize(I)I': (t, [self, id]) => recordOrThrow(t, store(t, self), id).length,
    'getRecord(I)[B': (t, [self, id]) => {
      const rec = recordOrThrow(t, store(t, self), id);
      return rec.length ? toJavaBytes(rec) : null;
    },
    'getRecord(I[BII)I': (t, [self, id, buffer, offset, len]) => {
      const peer = store(t, self);
      const rec = recordOrThrow(t, peer, id);
      if (buffer === null) throw t.jvm.npe();
      // 长度不能超过记录真实长度，也不能越界；规范允许读到短一点
      const want = Math.max(0, len);
      if (offset < 0 || want > rec.length || offset + want > (buffer.d as Int8Array).length) {
        throw t.jvm.throwable('java/lang/ArrayIndexOutOfBoundsException');
      }
      const n = Math.min(want, rec.length);
      (buffer.d as Int8Array).set(new Int8Array(rec.buffer, rec.byteOffset, n), offset);
      // 返回实际读入的字节数
      return n;
    },
    'enumerateRecords(Ljavax/microedition/rms/RecordFilter;Ljavax/microedition/rms/RecordComparator;Z)Ljavax/microedition/rms/RecordEnumeration;':
      (t, [self, filter, comparator]) => {
        store(t, self);
        const e = new JObject(t.jvm.loadClass('j2me/RecordEnumerationImpl'));
        e.n = { store: self, filter, comparator, ids: [] as number[], index: 0 };
        rebuild(t, e);
        return e;
      },
    'addRecordListener(Ljavax/microedition/rms/RecordListener;)V': (t, [self, l]) => {
      const peer = store(t, self);
      if (l && !peer.listeners.includes(l)) peer.listeners.push(l);
    },
    'removeRecordListener(Ljavax/microedition/rms/RecordListener;)V': (t, [self, l]) => {
      const peer = store(t, self);
      peer.listeners = peer.listeners.filter((x) => x !== l);
    },
    'setMode(IZ)V': () => {},
  },
};

function rebuild(t: JThread, e: JObject) {
  const jvm = t.jvm;
  const { store: storeObj, filter, comparator } = e.n as { store: JObject; filter: JRef; comparator: JRef };
  const records = (storeObj.n as StorePeer).data.records;
  let ids = [...records.keys()].sort((a, b) => b - a);
  if (filter instanceof JObject) {
    ids = ids.filter((id) => jvm.callVirtualSync(t, filter, 'matches([B)Z', [toJavaBytes(records.get(id)!)]) === 1);
  }
  if (comparator instanceof JObject) {
    ids.sort((a, b) => jvm.callVirtualSync(t, comparator, 'compare([B[B)I', [toJavaBytes(records.get(a)!), toJavaBytes(records.get(b)!)]) as number);
  }
  e.n.ids = ids;
  e.n.index = 0;
}

const enumerationImpl: NativeClassDef = {
  name: 'j2me/RecordEnumerationImpl',
  interfaces: ['javax/microedition/rms/RecordEnumeration'],
  methods: {
    'numRecords()I': (_t, [self]) => self.n.ids.length,
    'hasNextElement()Z': (_t, [self]) => self.n.index < self.n.ids.length,
    'hasPreviousElement()Z': (_t, [self]) => self.n.index > 0,
    'nextRecordId()I': (t, [self]) => {
      if (self.n.index >= self.n.ids.length) throw t.jvm.throwable('javax/microedition/rms/InvalidRecordIDException');
      return self.n.ids[self.n.index++];
    },
    'nextRecord()[B': (t, [self]) => {
      if (self.n.index >= self.n.ids.length) throw t.jvm.throwable('javax/microedition/rms/InvalidRecordIDException');
      const id = self.n.ids[self.n.index++];
      return toJavaBytes(recordOrThrow(t, self.n.store.n, id));
    },
    'previousRecordId()I': (t, [self]) => {
      if (self.n.index <= 0) throw t.jvm.throwable('javax/microedition/rms/InvalidRecordIDException');
      return self.n.ids[--self.n.index];
    },
    'previousRecord()[B': (t, [self]) => {
      if (self.n.index <= 0) throw t.jvm.throwable('javax/microedition/rms/InvalidRecordIDException');
      return toJavaBytes(recordOrThrow(t, self.n.store.n, self.n.ids[--self.n.index]));
    },
    'reset()V': (_t, [self]) => {
      self.n.index = 0;
    },
    'rebuild()V': (t, [self]) => rebuild(t, self),
    'keepUpdated(Z)V': () => {},
    'isKeptUpdated()Z': () => false,
    'destroy()V': () => {},
  },
};

const iface = (name: string): NativeClassDef => ({ name, flags: ACC_INTERFACE | ACC_ABSTRACT });

export const rmsNatives: NativeClassDef[] = [
  recordStoreClass,
  enumerationImpl,
  iface('javax/microedition/rms/RecordEnumeration'),
  iface('javax/microedition/rms/RecordFilter'),
  iface('javax/microedition/rms/RecordComparator'),
  iface('javax/microedition/rms/RecordListener'),
];
