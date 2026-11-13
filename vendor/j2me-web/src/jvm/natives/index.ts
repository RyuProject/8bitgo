import type { NativeClassDef } from '../jvm';
import { ioNatives } from './io';
import { langNatives } from './lang';
import { lcduiNatives } from './lcdui';
import { mediaNatives } from './media';
import { midletNatives } from './midlet';
import { rmsNatives } from './rms';
import { utilNatives } from './util';
import { vendorNatives } from './vendor';

export const allNatives: NativeClassDef[] = [
  ...langNatives,
  ...ioNatives,
  ...utilNatives,
  ...midletNatives,
  ...lcduiNatives,
  ...mediaNatives,
  ...rmsNatives,
  ...vendorNatives,
];
