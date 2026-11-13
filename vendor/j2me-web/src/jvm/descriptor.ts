export interface MethodSignature {
  params: string[];
  ret: string;
  /** Operand stack slots taken by the parameters (longs/doubles take two), excluding `this`. */
  argSlots: number;
  retSlots: 0 | 1 | 2;
}

const cache = new Map<string, MethodSignature>();

export function parseMethodDescriptor(desc: string): MethodSignature {
  let sig = cache.get(desc);
  if (sig) return sig;

  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ')') {
    const start = i;
    while (desc[i] === '[') i++;
    if (desc[i] === 'L') i = desc.indexOf(';', i);
    i++;
    params.push(desc.slice(start, i));
  }
  const ret = desc.slice(i + 1);
  const argSlots = params.reduce((n, p) => n + slotSize(p), 0);
  const retSlots = ret === 'V' ? 0 : slotSize(ret);
  sig = { params, ret, argSlots, retSlots };
  cache.set(desc, sig);
  return sig;
}

export function slotSize(type: string): 1 | 2 {
  return type === 'J' || type === 'D' ? 2 : 1;
}

/** "java/lang/String" → "java.lang.String", "[I" → "int[]" (for messages and Class.getName). */
export function javaName(internal: string): string {
  return internal.replace(/\//g, '.');
}
