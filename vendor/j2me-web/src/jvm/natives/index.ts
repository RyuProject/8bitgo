import type { NativeClassDef } from '../jvm';
import { gameLayerNatives } from './gamelayer';
import { ioNatives } from './io';
import { langNatives } from './lang';
import { lcduiNatives } from './lcdui';
import { mediaNatives } from './media';
import { midletNatives } from './midlet';
import { netStubNatives } from './netstub';
import { nokiaNatives } from './nokia';
import { rmsNatives } from './rms';
import { utilNatives } from './util';
import { vendorNatives } from './vendor';

export const allNatives: NativeClassDef[] = [
  ...langNatives,
  ...ioNatives,
  ...utilNatives,
  ...midletNatives,
  ...lcduiNatives,
  ...gameLayerNatives,
  ...mediaNatives,
  ...rmsNatives,
  ...vendorNatives,
  ...nokiaNatives,
  ...netStubNatives,
];
