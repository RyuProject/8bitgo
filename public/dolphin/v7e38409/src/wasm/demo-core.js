const I32 = 0x7f;
const FUNC = 0x60;

function encodeU32(value) {
  const bytes = [];
  let current = value >>> 0;

  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (current !== 0);

  return bytes;
}

function encodeName(name) {
  const bytes = Array.from(new TextEncoder().encode(name));
  return [...encodeU32(bytes.length), ...bytes];
}

function section(id, content) {
  return [id, ...encodeU32(content.length), ...content];
}

function byteVec(items) {
  return [...encodeU32(items.length), ...items];
}

function op(byte, ...args) {
  return [byte, ...args.flat()];
}

const localGet = (index) => op(0x20, ...encodeU32(index));
const localSet = (index) => op(0x21, ...encodeU32(index));
const i32Const = (value) => op(0x41, ...encodeU32(value));

export function createDemoCoreWasmBytes() {
  const typeSection = section(1, [
    ...encodeU32(1),
      FUNC,
      ...byteVec([I32, I32, I32, I32]),
      ...byteVec([I32])
  ]);

  const functionSection = section(3, [...encodeU32(1), ...encodeU32(0)]);
  const exportEntry = [...encodeName("pixel"), 0x00, ...encodeU32(0)];
  const exportSection = section(7, [
    ...encodeU32(1),
    ...exportEntry
  ]);

  const expression = [
    ...localGet(0),
    ...localGet(2),
    0x6a,
    ...i32Const(255),
    0x71,
    ...localSet(4),

    ...localGet(1),
    ...localGet(2),
    ...i32Const(1),
    0x76,
    0x6a,
    ...i32Const(255),
    0x71,
    ...localSet(5),

    ...localGet(0),
    ...localGet(1),
    0x73,
    ...localGet(3),
    ...i32Const(17),
    0x6c,
    0x6a,
    ...i32Const(255),
    0x71,
    ...localSet(6),

    ...i32Const(255),
    ...i32Const(24),
    0x74,
    ...localGet(6),
    ...i32Const(16),
    0x74,
    0x72,
    ...localGet(5),
    ...i32Const(8),
    0x74,
    0x72,
    ...localGet(4),
    0x72,
    0x0b
  ];

  const locals = [1, 3, I32];
  const body = [...locals, ...expression];
  const codeSection = section(10, [
    ...encodeU32(1),
    ...encodeU32(body.length),
    ...body
  ]);

  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSection,
    ...functionSection,
    ...exportSection,
    ...codeSection
  ]);
}

export async function instantiateDemoCore() {
  return WebAssembly.instantiate(createDemoCoreWasmBytes(), {});
}
