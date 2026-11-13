import type { Platform } from '../../platform/platform';
import { ACC_ABSTRACT } from '../classfile';
import type { NativeClassDef } from '../jvm';
import { DEAD } from '../thread';
import { BLOCK } from '../types';

const midletClass: NativeClassDef = {
  name: 'javax/microedition/midlet/MIDlet',
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': () => {},
    'getAppProperty(Ljava/lang/String;)Ljava/lang/String;': (t, [, key]) => {
      if (key === null) throw t.jvm.npe();
      return (t.jvm.platform as Platform).appProperty(key);
    },
    'notifyDestroyed()V': (t) => {
      (t.jvm.platform as Platform).config.onExit();
      t.jvm.halt('exit');
      t.state = DEAD;
      return BLOCK;
    },
    'notifyPaused()V': () => {},
    'resumeRequest()V': () => {},
    'platformRequest(Ljava/lang/String;)Z': (t, [, url]) => {
      (t.jvm.platform as Platform).config.log('info', `platformRequest ignored: ${url}`);
      return false;
    },
    'checkPermission(Ljava/lang/String;)I': () => 1,
  },
};

export const midletNatives: NativeClassDef[] = [midletClass];
