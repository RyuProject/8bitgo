import DiabloBinary from './Diablo.wasm';
import DiabloModule from './Diablo.jscc';
import SpawnBinary from './DiabloSpawn.wasm';
import SpawnModule from './DiabloSpawn.jscc';
import axios from 'axios';

import websocket_open from './websocket';

/* global FileReaderSync */

const DiabloSize = 1466809;
const SpawnSize = 1337416;

/* eslint-disable-next-line no-restricted-globals */
const worker = self;

let canvas = null, context = null;
let imageData = null;
let files = null;
let renderBatch = null;
let drawBelt = null;
let is_spawn = false;
let websocket = null;

function onError(err, action="error") {
  if (err instanceof Error) {
    worker.postMessage({action, error: err.toString(), stack: err.stack});
  } else {
    worker.postMessage({action, error: err.toString()});
  }
}

const ChunkSize = 1 << 20;
const MaxCachedChunks = 64;

/*
  MPQ 通常接近 500MB。旧实现即使走 HTTP Range，也先 new Uint8Array(整盘大小)；
  本地 File 更是先 FileReader 全读进内存，再复制进 worker。两条路都会在移动端直接爆堆。
  这里统一成 1MB 分块 + 64MB LRU，核心仍拿同步 subarray，只有实际读到的块才占内存。
*/
class ChunkedFile {
  constructor(byteLength, readChunk) {
    this.byteLength = byteLength;
    this.readChunk = readChunk;
    this.cache = new Map();
  }

  chunk(index) {
    const hit = this.cache.get(index);
    if (hit) {
      this.cache.delete(index);
      this.cache.set(index, hit);
      return hit;
    }
    const start = index * ChunkSize;
    const end = Math.min(this.byteLength, start + ChunkSize);
    const raw = this.readChunk(start, end - 1);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength !== end - start) {
      throw Error(`Incomplete MPQ block: expected ${end - start}, received ${bytes.byteLength}`);
    }
    this.cache.set(index, bytes);
    while (this.cache.size > MaxCachedChunks) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return bytes;
  }

  subarray(start, end) {
    const from = Math.max(0, Math.min(this.byteLength, Math.trunc(start)));
    const to = Math.max(from, Math.min(this.byteLength, Math.trunc(end)));
    const output = new Uint8Array(to - from);
    if (!output.length) return output;
    const first = Math.floor(from / ChunkSize);
    const last = Math.floor((to - 1) / ChunkSize);
    for (let index = first; index <= last; index++) {
      const chunk = this.chunk(index);
      const chunkStart = index * ChunkSize;
      const copyFrom = Math.max(from, chunkStart) - chunkStart;
      const copyTo = Math.min(to, chunkStart + chunk.byteLength) - chunkStart;
      output.set(chunk.subarray(copyFrom, copyTo), chunkStart + copyFrom - from);
    }
    return output;
  }
}

class RemoteFile extends ChunkedFile {
  constructor(url) {
    const request = new XMLHttpRequest();
    request.open('HEAD', url, false);
    request.send();
    if (request.status < 200 || request.status >= 300) {
      throw Error('Failed to load remote file');
    }
    const byteLength = Number(request.getResponseHeader('Content-Length'));
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw Error('Remote MPQ has no valid size');
    super(byteLength, (start, endInclusive) => {
      const part = new XMLHttpRequest();
      part.open('GET', url, false);
      part.setRequestHeader('Range', `bytes=${start}-${endInclusive}`);
      part.responseType = 'arraybuffer';
      part.send();
      // 忽略 Range 却回 200 会把整份 500MB MPQ 塞进一个 1MB 槽；必须当场拒绝。
      if (part.status !== 206) throw Error(`Remote MPQ requires HTTP 206, received ${part.status || 'network error'}`);
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(part.getResponseHeader('Content-Range') || '');
      if (!match || Number(match[1]) !== start || Number(match[2]) !== endInclusive || Number(match[3]) !== byteLength) {
        throw Error('Remote MPQ returned an invalid Content-Range');
      }
      return new Uint8Array(part.response);
    });
  }
}

class BlobFile extends ChunkedFile {
  constructor(file) {
    const reader = new FileReaderSync();
    super(file.size, (start, endInclusive) =>
      new Uint8Array(reader.readAsArrayBuffer(file.slice(start, endInclusive + 1))));
  }
}

const DApi = {
  exit_error(error) {
    throw Error(error);
  },

  exit_game() {
    worker.postMessage({action: "exit"});
  },
  current_save_id(id) {
    worker.postMessage({action: "current_save", name: id >= 0 ? (is_spawn ? `spawn${id}.sv` : `single_${id}.sv`) : null});
  },

  get_file_size(path) {
    const data = files.get(path.toLowerCase());
    return data ? data.byteLength : 0;
  },
  get_file_contents(path, array, offset) {
    const data = files.get(path.toLowerCase());
    if (data) {
      array.set(data.subarray(offset, offset + array.byteLength));
    }
  },
  put_file_contents(path, array) {
    path = path.toLowerCase();
    // if (!path.match(/^(spawn\d+\.sv|single_\d+\.sv|config\.ini)$/i)) {
    //   alert(`Bad file name: ${path}`);
    // }
    files.set(path, array);
    worker.postMessage({action: "fs", func: "update", params: [path, array]});
  },
  remove_file(path) {
    path = path.toLowerCase();
    files.delete(path);
    worker.postMessage({action: "fs", func: "delete", params: [path]});
  },

  set_cursor(x, y) {
    worker.postMessage({action: "cursor", x, y});
  },
  open_keyboard(...args) {
    worker.postMessage({action: "keyboard", rect: [...args]});
  },
  close_keyboard() {
    worker.postMessage({action: "keyboard", rect: null});
  },

  use_websocket(flag) {
    if (flag) {
      if (!websocket || websocket.readyState !== 1) {
        const sock = websocket = websocket_open('wss://diablo.rivsoft.net/websocket', data => {
          if (websocket === sock) {
            try_api(() => {
              const ptr = wasm._DApi_AllocPacket(data.byteLength);
              wasm.HEAPU8.set(new Uint8Array(data), ptr);
            });
          }
        }, code => {
          if (typeof code !== "number") {
            throw code;
          } else {
            call_api("SNet_WebsocketStatus", code);
          }
        });
      } else {
        call_api("SNet_WebsocketStatus", 0);
      }
    } else {
      if (websocket) {
        websocket.close();
      }
      websocket = null;
    }
  },
  websocket_closed() {
    return websocket ? websocket.readyState !== 1 : false;
  },
};
/*
let frameTime = 0, lastTime = 0;
function getFPS() {
  const time = performance.now();
  if (!lastTime) {
    lastTime = time;
  }
  frameTime = 0.9 * frameTime + 0.1 * (time - lastTime);
  lastTime = time;
  return frameTime ? 1000.0 / frameTime : 0.0;
}
*/
const DApi_renderLegacy = {
  draw_begin() {
    renderBatch = {
      images: [],
      text: [],
      clip: null,
      belt: drawBelt,
    };
    drawBelt = null;
  },
  draw_blit(x, y, w, h, data) {
    renderBatch.images.push({x, y, w, h, data: data.slice()});
  },
  draw_clip_text(x0, y0, x1, y1) {
    renderBatch.clip = {x0, y0, x1, y1};
  },
  draw_text(x, y, text, color) {
    renderBatch.text.push({x, y, text, color});
  },
  draw_end() {
    //DApi.draw_text(10, 10, `FPS: ${getFPS().toFixed(1)} (Transfer)`, 0xFFCC00);
    const transfer = renderBatch.images.map(({data}) => data.buffer);
    if (renderBatch.belt) {
      transfer.push(renderBatch.belt.buffer);
    }
    worker.postMessage({action: "render", batch: renderBatch}, transfer);
    renderBatch = null;
  },
  draw_belt(items) {
    drawBelt = items.slice();
  },
};

const DApi_renderOffscreen = {
  draw_begin() {
    context.save();
    context.font = 'bold 13px Times New Roman';
  },
  draw_blit(x, y, w, h, data) {
    imageData.data.set(data);
    context.putImageData(imageData, x, y);
  },
  draw_clip_text(x0, y0, x1, y1) {
    context.beginPath();
    context.rect(x0, y0, x1 - x0, y1 - y0);
    context.clip();
  },
  draw_text(x, y, text, color) {
    const r = ((color >> 16) & 0xFF);
    const g = ((color >> 8) & 0xFF);
    const b = (color & 0xFF);
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillText(text, x, y + 22);
  },
  draw_end() {
    //DApi.draw_text(10, 10, `FPS: ${getFPS().toFixed(1)} (Offscreen)`, 0xFFCC00);
    context.restore();
    const bitmap = canvas.transferToImageBitmap();
    const transfer = [bitmap];
    if (drawBelt) {
      transfer.push(drawBelt.buffer);
    }
    worker.postMessage({action: "render", batch: {bitmap, belt: drawBelt}}, transfer);
    drawBelt = null;
  },
  draw_belt(items) {
    drawBelt = items.slice();
  },
};

let audioBatch = null, audioTransfer = null;
let maxSoundId = 0, maxBatchId = 0;
["create_sound_raw", "create_sound", "duplicate_sound"].forEach(func => {
  DApi[func] = function(...params) {
    if (audioBatch) {
      maxBatchId = params[0] + 1;
      audioBatch.push({func, params});
      if (func !== "duplicate_sound") {
        audioTransfer.push(params[1].buffer);
      }
    } else {
      maxSoundId = params[0] + 1;
      const transfer = [];
      if (func !== "duplicate_sound") {
        transfer.push(params[1].buffer);
      }
      worker.postMessage({action: "audio", func, params}, transfer);
    }
  };
});
["play_sound", "set_volume", "stop_sound", "delete_sound"].forEach(func => {
  DApi[func] = function(...params) {
    if (audioBatch && params[0] >= maxSoundId) {
      audioBatch.push({func, params});
    } else {
      worker.postMessage({action: "audio", func, params});
    }
  }
});

let packetBatch = null;
DApi.websocket_send = function(data) {
  if (websocket) {
    websocket.send(data);
  } else if (packetBatch) {
    packetBatch.push(data.slice().buffer);
  } else {
    worker.postMessage({action: "packet", buffer: data});
  }
};

worker.DApi = DApi;

let wasm = null;

function try_api(func) {
  try {
    func();
  } catch (e) {
    onError(e);
  }
}

function call_api(func, ...params) {
  try_api(() => {
    const nested = (audioBatch != null);
    if (!nested) {
      audioBatch = [];
      audioTransfer = [];
      packetBatch = [];
    }
    if (func !== "text") {
      wasm["_" + func](...params);
    } else {
      const ptr = wasm._DApi_SyncTextPtr();
      const text = params[0];
      const length = Math.min(text.length, 255);
      const heap = wasm.HEAPU8;
      for (let i = 0; i < length; ++i) {
        heap[ptr + i] = text.charCodeAt(i);
      }
      heap[ptr + length] = 0;
      wasm._DApi_SyncText(params[1]);
    }
    if (!nested) {
      if (audioBatch.length) {
        maxSoundId = maxBatchId;
        worker.postMessage({action: "audioBatch", batch: audioBatch}, audioTransfer);
      }
      if (packetBatch.length) {
        worker.postMessage({action: "packetBatch", batch: packetBatch}, packetBatch);
      }
      audioBatch = null;
      audioTransfer = null;
      packetBatch = null;
    }
  });
}

function progress(text, loaded, total) {
  worker.postMessage({action: "progress", text, loaded, total});
}

async function initWasm(spawn, progress) {
  const binary = await axios.request({
    url: spawn ? SpawnBinary : DiabloBinary,
    responseType: 'arraybuffer',
    onDownloadProgress: progress,
  });
  const result = await (spawn ? SpawnModule : DiabloModule)({wasmBinary: binary.data}).ready;
  progress({loaded: 2000000});
  return result;
}

async function init_game(mpq, spawn, offscreen) {
  is_spawn = spawn;
  if (offscreen) {
    canvas = new OffscreenCanvas(640, 480);
    context = canvas.getContext("2d");
    imageData = context.createImageData(640, 480);
    Object.assign(DApi, DApi_renderOffscreen);
  } else {
    Object.assign(DApi, DApi_renderLegacy);
  }

  if (!mpq) {
    const name = (spawn ? 'spawn.mpq' : 'diabdat.mpq');
    if (!files.has(name)) {
      // This should never happen, but we do support remote loading
      files.set(name, new RemoteFile(`${process.env.PUBLIC_URL}/${name}`));
    }
  }

  progress("Loading...");
  let mpqLoaded = (mpq ? mpq.size : 0), mpqTotal = mpqLoaded, wasmLoaded = 0, wasmTotal = (spawn ? SpawnSize : DiabloSize);
  const wasmWeight = 5;
  function updateProgress() {
    progress("Loading...", mpqLoaded + wasmLoaded * wasmWeight, mpqTotal + wasmTotal * wasmWeight);
  }
  const loadWasm = initWasm(spawn, e => {
    wasmLoaded = Math.min(e.loaded, wasmTotal);
    updateProgress();
  });
  // File 本身可结构化克隆到 worker；FileReaderSync 只按核心真正读取的 1MB 块取数据。
  let loadMpq = Promise.resolve(mpq ? new BlobFile(mpq) : null);
  [wasm, mpq] = await Promise.all([loadWasm, loadMpq]);

  if (mpq) {
    files.set(spawn ? 'spawn.mpq' : 'diabdat.mpq', mpq);
  }

  progress("Initializing...");

  const vers = process.env.VERSION.match(/(\d+)\.(\d+)\.(\d+)/);

  //wasm._SNet_InitWebsocket();
  wasm._DApi_Init(Math.floor(performance.now()), offscreen ? 1 : 0, parseInt(vers[1]), parseInt(vers[2]), parseInt(vers[3]));

  setInterval(() => {
    call_api("DApi_Render", Math.floor(performance.now()));  
  }, 50);
}

worker.addEventListener("message", ({data}) => {
  switch (data.action) {
  case "init":
    files = data.files;
    init_game(data.mpq, data.spawn, data.offscreen).then(
      () => worker.postMessage({action: "loaded"}),
      e => onError(e, "failed"));
    break;
  case "event":
    call_api(data.func, ...data.params);
    break;
  case "packet":
    try_api(() => {
      const ptr = wasm._DApi_AllocPacket(data.buffer.byteLength);
      wasm.HEAPU8.set(new Uint8Array(data.buffer), ptr);
    });
    break;
  case "packetBatch":
    try_api(() => {
      for (let packet of data.batch) {
        const ptr = wasm._DApi_AllocPacket(packet.byteLength);
        wasm.HEAPU8.set(new Uint8Array(packet), ptr);
      }
    });
    break;
  default:
  }
});
