/*
 * 8BitGo：把 N-Gage 卡带转储（.zip）导入 EKA2L1-WEB 的 E: 盘。
 *
 * 为什么要有它：第一代 N-Gage 游戏装在 MMC 卡里，No-Intro 这类转储是卡上的原始目录
 * （根目录的 game.id / nokia.dat + System/Apps/<代号>/…），不是 .sis / .n-gage 安装包。
 * 「安装 SIS」装不上它，「文件管理」一次只能把文件平铺进一个目录。桌面版 EKA2L1 有
 * 「安装 N-Gage 卡带游戏」（上游 system_impl::install_ngage_game_card），网页版没有导出，
 * 这里照它的规则在 JS 里重做一遍：
 *   1. 以 system/apps/ 定位卡带根目录，取最浅的一处（兼容外面又包了一层文件夹的压缩包）；
 *   2. System/Apps 下只能有一款游戏：一个目录，或 <代号> 与 <代号>_1 两个版本（Browser 目录忽略）。
 *      两个版本时，_1 的 .app 能通过 E32 文件头校验才运行 _1，否则运行 <代号> —— 有的卡里 _1 只是
 *      几百字节的存根（《模拟人生：脱颖而出》的 6rak_1.app 声明 4868 字节代码，文件只有 416 字节）；
 *   3. 卡带根目录整体复制到 E:\，不运行的版本不写 .aif（两份 AIF 是同一个 UID，只能注册一个）；
 *   4. System/Libs、System/Programs 另复制一份进 E:\System\Apps\<代号>\。
 *
 * 网页版虚拟盘区分大小写，而客体按小写物理文件名查找（见上游 index.js 的上传说明），所以目标路径一律小写。
 * 所有文件先解压进内存并逐个核对 CRC-32，任何一项不对都不落盘；落盘后只持久化这些路径（不做整盘
 * syncfs），然后刷新页面 —— 应用列表服务只在核心启动时扫描各盘的 System\Apps。
 *
 * 纯逻辑挂在 globalThis.EightBitGoNgageCard 上，scripts/test-eka2l1-ngage-card.mjs 在 Node 里直接测。
 */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({
    archiveBytes: 512 * 1048576,
    totalBytes: 512 * 1048576,
    fileBytes: 256 * 1048576,
    entries: 20000,
  });
  const E_ROOT = '/eka2l1/drives/e/';
  const C_ROOT = '/eka2l1/drives/c';
  const APPS = 'system/apps/';
  const LIB_DIRS = ['system/libs/', 'system/programs/'];
  const IMPORTED_KEY = '8bitgo.eka2l1.ngageCardImported';

  class CardError extends Error {
    constructor(code, detail) {
      super(detail ? code + ': ' + detail : code);
      this.name = 'CardError';
      this.code = code;
      this.detail = detail || '';
    }
  }

  // ---- 校验和 ---------------------------------------------------------------

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Symbian 的 TCheckedUid：偶数字节、奇数字节各做一次 Mem::Crc（CRC-16/CCITT，初值 0）
  const CCITT_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
      table[n] = c;
    }
    return table;
  })();

  function symbianCrc16(bytes) {
    let crc = 0;
    for (const b of bytes) crc = ((crc << 8) & 0xFFFF) ^ CCITT_TABLE[((crc >> 8) ^ b) & 0xFF];
    return crc;
  }

  function checkedUidMatches(bytes) {
    if (bytes.length < 16) return false;
    const even = [];
    const odd = [];
    for (let i = 0; i < 12; i++) (i % 2 ? odd : even).push(bytes[i]);
    return (((symbianCrc16(odd) << 16) | symbianCrc16(even)) >>> 0) === u32(bytes, 12);
  }

  function u16(bytes, at) { return bytes[at] | (bytes[at + 1] << 8); }
  function u32(bytes, at) { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }

  /**
   * 照上游 loader::parse_e32img 的判据判断一个 .app 能不能加载：签名、UID 校验和，以及
   * validate_e32img_layout 的各段边界。压缩映像不解压，按头里声明的解压后大小核对。
   */
  function e32Loadable(bytes) {
    if (!bytes || bytes.length < 0x7C) return false;
    if (u32(bytes, 0x10) !== 0x434F5045) return false; // 'EPOC'
    if (!checkedUidMatches(bytes)) return false;
    const cpu = u32(bytes, 0x14);
    const eka1 = cpu === 0x2000 || cpu === 0x1000;
    const flags = u32(bytes, 0x2C);
    let compression = u32(bytes, 0x1C);
    if (eka1 && !(flags & 0x0F000000)) compression = 0;
    const headerFormat = (flags >>> 24) & 0xF;
    const codeSize = u32(bytes, 0x30);
    const textSize = u32(bytes, 0x60);
    const codeOffset = u32(bytes, 0x64);
    let size = bytes.length;
    if (compression) {
      const uncompressed = headerFormat > 0 && bytes.length >= 0x80 ? u32(bytes, 0x7C) : 0;
      size = uncompressed + codeOffset;
    }
    const within = (offset, length) => offset + length <= size;
    if (textSize > codeSize) return false;
    if (!within(codeOffset, codeSize)) return false;
    const exportDirOffset = u32(bytes, 0x58);
    if (exportDirOffset && !within(exportDirOffset, u32(bytes, 0x5C) * 4)) return false;
    if (u32(bytes, 0x54) && !within(u32(bytes, 0x6C), 4)) return false;
    const codeReloc = u32(bytes, 0x70);
    if (codeReloc && !within(codeReloc, 8)) return false;
    const dataReloc = u32(bytes, 0x74);
    if (dataReloc && !within(dataReloc, 8)) return false;
    return true;
  }

  /** AIF 是直接文件存储（KDirectFileStoreLayoutUid）+ KUidAppInfoFile，UID 校验和必须对得上 */
  function aifLooksValid(bytes) {
    if (!bytes || bytes.length < 16) return false;
    const uid1 = u32(bytes, 0);
    if (uid1 !== 0x10000037 && uid1 !== 0x10000050) return false;
    return u32(bytes, 4) === 0x10003A38 && checkedUidMatches(bytes);
  }

  // ---- ZIP 中央目录 ----------------------------------------------------------

  async function readBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  const utf8 = new TextDecoder('utf-8');

  function decodeName(bytes, flags) {
    if (flags & 0x800) return utf8.decode(bytes);
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }

  function mib(bytes) { return Math.round(bytes / 1048576) + ' MiB'; }

  async function readZipDirectory(blob, limits = LIMITS) {
    if (!blob || blob.size < 22) throw new CardError('not-zip');
    if (blob.size > limits.archiveBytes) throw new CardError('too-large', mib(limits.archiveBytes));
    const tailStart = Math.max(0, blob.size - (22 + 0xFFFF));
    const tail = await readBytes(blob, tailStart, blob.size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4B && tail[i + 2] === 0x05 && tail[i + 3] === 0x06
        && i + 22 + u16(tail, i + 20) <= tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new CardError('not-zip');
    if (eocd >= 20 && u32(tail, eocd - 20) === 0x07064B50) throw new CardError('zip64');
    const entriesOnDisk = u16(tail, eocd + 8);
    const total = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (total === 0xFFFF || entriesOnDisk === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw new CardError('zip64');
    }
    if (u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0 || entriesOnDisk !== total) {
      throw new CardError('multi-disk');
    }
    if (total > limits.entries) throw new CardError('too-many', String(total));
    if (cdOffset + cdSize > tailStart + eocd) throw new CardError('corrupt', 'central directory');

    const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
    const entries = [];
    let p = 0;
    for (let index = 0; index < total; index++) {
      if (p + 46 > cd.length || u32(cd, p) !== 0x02014B50) throw new CardError('corrupt', 'central directory');
      const flags = u16(cd, p + 8);
      const nameLength = u16(cd, p + 28);
      const next = p + 46 + nameLength + u16(cd, p + 30) + u16(cd, p + 32);
      if (next > cd.length) throw new CardError('corrupt', 'central directory');
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLength), flags);
      entries.push({
        index,
        name,
        flags,
        method: u16(cd, p + 10),
        crc: u32(cd, p + 16),
        compressedSize: u32(cd, p + 20),
        size: u32(cd, p + 24),
        localOffset: u32(cd, p + 42),
        isDir: /[\\/]$/.test(name),
      });
      p = next;
    }
    return entries;
  }

  /** 统一成 a/b/c；绝对路径、盘符、..、控制字符和 Symbian 不允许的字符一律拒绝 */
  function normalizeEntryPath(name) {
    const raw = String(name).replace(/\\/g, '/');
    // eslint-disable-next-line no-control-regex -- 就是要拦控制字符
    if (raw.startsWith('/') || /[\u0000-\u001f<>:"|?*]/.test(raw)) throw new CardError('unsafe-path', name);
    const parts = [];
    for (const segment of raw.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') throw new CardError('unsafe-path', name);
      parts.push(segment);
    }
    return parts.join('/');
  }

  /** macOS / Windows 压缩时顺手塞进来的元数据，不是卡带内容 */
  function isJunk(path) {
    const parts = path.split('/');
    const base = parts[parts.length - 1].toLowerCase();
    return parts[0].toLowerCase() === '__macosx' || base.startsWith('._')
      || base === '.ds_store' || base === 'thumbs.db' || base === 'desktop.ini';
  }

  /** 上游 find_ngage_card_root_in_archive：system/apps/ 出现在开头或某个 / 之后，最浅的一处是卡带根 */
  function findCardRoot(paths) {
    let best = null;
    for (const path of paths) {
      const lower = path.toLowerCase();
      for (let pos = lower.indexOf(APPS); pos !== -1; pos = lower.indexOf(APPS, pos + 1)) {
        if (pos !== 0 && lower[pos - 1] !== '/') continue;
        if (best === null || pos < best.length) best = lower.slice(0, pos);
        break;
      }
    }
    return best;
  }

  // ---- 解压单个成员 ----------------------------------------------------------

  async function readEntryData(blob, entry) {
    if (entry.flags & 0x1) throw new CardError('encrypted', entry.name);
    if (entry.method !== 0 && entry.method !== 8) throw new CardError('method', entry.name);
    const header = await readBytes(blob, entry.localOffset, entry.localOffset + 30);
    if (header.length < 30 || u32(header, 0) !== 0x04034B50) throw new CardError('corrupt', entry.name);
    const start = entry.localOffset + 30 + u16(header, 26) + u16(header, 28);
    const end = start + entry.compressedSize;
    if (end > blob.size) throw new CardError('corrupt', entry.name);

    let out;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new CardError('corrupt', entry.name);
      out = await readBytes(blob, start, end);
    } else {
      out = new Uint8Array(entry.size);
      let stream;
      try {
        stream = blob.slice(start, end).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      } catch (err) {
        throw new CardError('inflate-unsupported', err && err.message);
      }
      const reader = stream.getReader();
      let offset = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          // 中央目录声明的大小就是上限：解出来更多说明包坏了或被构造过，不能继续往内存里塞
          if (offset + part.value.length > out.length) {
            reader.cancel().catch(() => {});
            throw new CardError('corrupt', entry.name);
          }
          out.set(part.value, offset);
          offset += part.value.length;
        }
      } catch (err) {
        if (err instanceof CardError) throw err;
        throw new CardError('corrupt', entry.name);
      }
      if (offset !== out.length) throw new CardError('corrupt', entry.name);
    }
    if (crc32(out) !== entry.crc) throw new CardError('corrupt', entry.name + ' (CRC)');
    return out;
  }

  // ---- 安装计划 --------------------------------------------------------------

  function cleanTitle(bytes) {
    // eslint-disable-next-line no-control-regex -- 就是要拦控制字符
    const text = utf8.decode(bytes).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return text.slice(0, 80);
  }

  /**
   * 只读不写：定位卡带根、选出要运行的版本、算出每个文件落到 E: 盘的哪里。
   * 返回的 dest 是相对 E:\ 的小写路径。
   */
  async function planCard(blob, entries, limits = LIMITS) {
    const files = [];
    for (const entry of entries) {
      const path = normalizeEntryPath(entry.name);
      if (entry.isDir || !path || isJunk(path)) continue;
      files.push({ entry, path });
    }
    const prefix = findCardRoot(files.map((f) => f.path));
    if (prefix === null) throw new CardError('no-game');

    const card = [];
    for (const f of files) {
      if (!f.path.toLowerCase().startsWith(prefix)) continue;
      const rel = f.path.slice(prefix.length);
      card.push({ entry: f.entry, rel, lower: rel.toLowerCase() });
    }
    const byLower = new Map(card.map((f) => [f.lower, f]));

    // System/Apps 下有文件的直接子目录才算游戏目录
    const folders = new Map();
    for (const f of card) {
      if (!f.lower.startsWith(APPS)) continue;
      const rest = f.rel.slice(APPS.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const name = rest.slice(0, slash);
      if (name.toLowerCase() === 'browser') continue;
      if (!folders.has(name.toLowerCase())) folders.set(name.toLowerCase(), name);
    }
    const names = [...folders.keys()];
    if (!names.length) throw new CardError('no-game');
    if (names.length > 2) throw new CardError('multiple-games', [...folders.values()].join(', '));

    let run = names[0];
    let drop = '';
    let libs = names[0];
    if (names.length === 2) {
      const alternates = names.filter((n) => n.endsWith('_1'));
      if (alternates.length !== 1) throw new CardError('multiple-games', [...folders.values()].join(', '));
      const alternate = alternates[0];
      const base = names.find((n) => n !== alternate);
      const appFile = byLower.get(APPS + alternate + '/' + alternate + '.app');
      let loadable = false;
      if (appFile && appFile.entry.size <= limits.fileBytes) {
        loadable = e32Loadable(await readEntryData(blob, appFile.entry));
      }
      run = loadable ? alternate : base;
      drop = loadable ? base : alternate;
      libs = base;
    }

    const aif = byLower.get(APPS + run + '/' + run + '.aif');
    if (!aif) throw new CardError('no-registration', folders.get(run));
    const aifBytes = aif.entry.size <= 1048576 ? await readEntryData(blob, aif.entry) : null;
    if (!aifLooksValid(aifBytes)) throw new CardError('bad-registration', aif.rel);
    // AIF 的第三个 UID 就是应用 UID：刷新后拿它核对应用列表里有没有这款游戏
    const appUid = u32(aifBytes, 8);

    const dropAif = drop ? APPS + drop + '/' + drop + '.aif' : '';
    const writes = new Map();
    for (const f of card) {
      if (f.lower === dropAif) continue;
      if (writes.has(f.lower)) throw new CardError('name-collision', f.rel);
      writes.set(f.lower, f.entry);
    }
    // 上游在整体复制之后再复制 Libs、Programs，所以同名时以它们为准
    for (const dir of LIB_DIRS) {
      for (const f of card) {
        if (f.lower.startsWith(dir)) writes.set(APPS + libs + '/' + f.lower.slice(dir.length), f.entry);
      }
    }

    let totalBytes = 0;
    for (const entry of writes.values()) {
      if (entry.size > limits.fileBytes) throw new CardError('too-large', entry.name);
      totalBytes += entry.size;
    }
    if (totalBytes > limits.totalBytes) throw new CardError('too-large', mib(limits.totalBytes));

    let title = '';
    const gameId = byLower.get('game.id');
    if (gameId && gameId.entry.size <= 512) {
      try { title = cleanTitle(await readEntryData(blob, gameId.entry)); } catch { title = ''; }
    }

    // C 盘存档目录用卡上的代号（大写，与游戏自己建出来的一致），两个版本都建，空目录无害
    const saveFolders = [...new Set([libs, run].map((name) => folders.get(name).toUpperCase()))];

    return {
      prefix,
      gameFolder: run,
      dropFolder: drop,
      libsFolder: libs,
      saveFolders,
      dropAif,
      appUid,
      title,
      totalBytes,
      writes: [...writes].map(([dest, entry]) => ({ dest, entry })),
    };
  }

  // ---- 写进模拟器 ------------------------------------------------------------

  function pathKind(FS, path) {
    try {
      return FS.isDir(FS.stat(path).mode) ? 'dir' : 'file';
    } catch {
      return '';
    }
  }

  function dirname(path) { return path.slice(0, path.lastIndexOf('/')); }

  /** parent 下按大小写不敏感找 name；没有就按给定大小写新建。被同名文件挡住返回 null */
  function ensureDirCaseInsensitive(FS, parent, name, created) {
    let entries = [];
    try { entries = FS.readdir(parent); } catch { return null; }
    const match = entries.find((e) => e !== '.' && e !== '..' && e.toLowerCase() === name.toLowerCase());
    if (match) {
      const existing = parent + '/' + match;
      return pathKind(FS, existing) === 'dir' ? existing : null;
    }
    const path = parent + '/' + name;
    FS.mkdir(path);
    created.push(path);
    return path;
  }

  /**
   * 存档文件不存在时走不通的游戏：导入时在 C:\System\Apps\<代号>\ 放一个空文件，游戏就走「已有存档」那条路。
   * 键是卡上的代号（大写），值是存档文件名。已有同名文件（不论大小写、不论内容）一律不动。
   *
   * 《模拟人生：脱颖而出》（6RAK）：2026-11-19 用带日志的诊断核心确认，存档不存在时游戏的「新建存档」路径让 ESTLIB
   * 从 0x40FEAC 起连续写 1024 字节一块的数据，这段地址在模拟器里是这个线程 64KB 栈（0x400000–0x410000）的顶部，
   * 再往上是没有提交的页，Posix 服务按 EFAULT 拒绝，存档只剩 0 字节，标题画面报「Game deck memory full」。
   * 把没映射的尾部按 0 补上也没用：游戏接着从 0x4102AC 写下一块，整块都在未映射区 —— 是游戏这条路径上的指针
   * 指进了栈区，模拟器层面没有干净的通用修法。已有存档（哪怕 0 字节）时游戏从堆上的缓冲每次写 8 字节，存档正常写出
   * 6176 字节，标题显示「Press 5 to start」，主菜单正常。
   */
  const KNOWN_EMPTY_SAVES = Object.freeze({
    '6RAK': Object.freeze(['THESIMS.SAV']),
  });

  /**
   * 预先建出 C:\System\Apps\<代号>\（游戏第一次启动自己逐级 mkdir 也行，预建无害），并为 KNOWN_EMPTY_SAVES 里的游戏
   * 放好空存档。C 盘保留原大小写，已有目录不论大小写一律复用，不另建一份。失败不影响卡带导入本身。
   */
  function prepareSaveFolders(FS, folders) {
    const created = [];
    const seeded = [];
    const blocked = [];
    for (const folder of folders) {
      try {
        let dir = pathKind(FS, C_ROOT) === 'dir' ? C_ROOT : null;
        for (const name of ['System', 'Apps', folder]) {
          if (dir) dir = ensureDirCaseInsensitive(FS, dir, name, created);
        }
        if (!dir) {
          blocked.push(folder);
          continue;
        }
        const saves = KNOWN_EMPTY_SAVES[folder.toUpperCase()] || [];
        if (!saves.length) continue;
        const existing = new Set(FS.readdir(dir).map((e) => e.toLowerCase()));
        for (const name of saves) {
          if (existing.has(name.toLowerCase())) continue;
          const path = dir + '/' + name;
          FS.writeFile(path, new Uint8Array(0));
          seeded.push(path);
        }
      } catch {
        blocked.push(folder);
      }
    }
    return { created, seeded, blocked };
  }

  /**
   * deps: { FS, savePaths(paths, onProgress), deletePathPrefixes(prefixes), estimate(), onStage(stage, info) }
   * 全部解压并核对通过后才动 FS；写盘前先查 E: 盘上有没有挡路的同名目录 / 文件。
   */
  async function installCard(blob, deps) {
    const limits = deps.limits || LIMITS;
    const stage = (name, info) => { if (deps.onStage) deps.onStage(name, info || {}); };
    const FS = deps.FS;

    stage('read');
    const entries = await readZipDirectory(blob, limits);
    const plan = await planCard(blob, entries, limits);

    if (deps.estimate) {
      const est = await deps.estimate();
      if (est && est.quota) {
        const largest = plan.writes.reduce((m, w) => Math.max(m, w.entry.size), 0);
        const need = plan.totalBytes + largest;
        const free = est.quota - (est.usage || 0);
        if (free < need) {
          throw new CardError('quota', Math.ceil(need / 1048576) + '/' + Math.max(0, Math.floor(free / 1048576)));
        }
      }
    }

    const targets = plan.writes.map((w) => ({ path: E_ROOT + w.dest, entry: w.entry }));
    for (const t of targets) {
      if (pathKind(FS, t.path) === 'dir') throw new CardError('fs-conflict', t.path.slice(E_ROOT.length));
      for (let dir = dirname(t.path); dir.length >= E_ROOT.length; dir = dirname(dir)) {
        if (pathKind(FS, dir) === 'file') throw new CardError('fs-conflict', dir.slice(E_ROOT.length));
      }
    }

    const decoded = new Map();
    const buffers = [];
    let done = 0;
    for (const t of targets) {
      stage('extract', { done, total: targets.length, name: t.entry.name });
      let data = decoded.get(t.entry.index);
      if (data) {
        data = data.slice(); // Libs 复制件：MEMFS 会接管数组，两个文件不能共用一块
      } else {
        data = await readEntryData(blob, t.entry);
        decoded.set(t.entry.index, data);
      }
      buffers.push({ path: t.path, data });
      done++;
    }

    stage('write', { total: buffers.length });
    for (const b of buffers) {
      FS.mkdirTree(dirname(b.path));
      FS.writeFile(b.path, b.data, { canOwn: true });
    }
    const paths = buffers.map((b) => b.path);
    const saveFolders = prepareSaveFolders(FS, plan.saveFolders || []);
    if (saveFolders.blocked.length) {
      console.warn('[8BitGo] 没能在 C 盘预建存档目录（有同名文件挡着）：', saveFolders.blocked.join(', '));
    }
    const persistPaths = [...paths, ...saveFolders.created, ...saveFolders.seeded];

    stage('persist', { total: persistPaths.length });
    try {
      await deps.savePaths(persistPaths, (written, total, bytes) => stage('persist', { written, total, bytes }));
    } catch (err) {
      throw new CardError('persist', (err && (err.message || err.name)) || String(err));
    }

    // 以前导入过、当时运行的是另一个版本：把那份 .aif 也去掉，否则同一个 UID 注册两次
    let removedStale = '';
    if (plan.dropAif) {
      const stale = E_ROOT + plan.dropAif;
      if (pathKind(FS, stale) === 'file') {
        try { FS.unlink(stale); } catch { /* 下面的 IndexedDB 删除照样做 */ }
        if (deps.deletePathPrefixes) await deps.deletePathPrefixes([stale]);
        removedStale = stale;
      }
    }

    return { plan, paths, removedStale, saveFolders };
  }

  const api = Object.freeze({
    LIMITS, E_ROOT, IMPORTED_KEY, KNOWN_EMPTY_SAVES, CardError,
    crc32, checkedUidMatches, e32Loadable, aifLooksValid,
    readZipDirectory, normalizeEntryPath, findCardRoot, readEntryData, planCard, installCard,
  });
  root.EightBitGoNgageCard = api;

  // 只在程序库页（index.html）接按钮；详情页的播放页（play.html）只用上面的纯逻辑
  if (typeof document === 'undefined' || !document.getElementById('sisInput')) return;

  // ---- 页面接线 --------------------------------------------------------------

  const MESSAGES = {
    'not-zip': ['这不是有效的 ZIP 文件。', 'This is not a valid ZIP file.'],
    zip64: ['不支持 ZIP64 压缩包，请用普通 ZIP 重新打包。', 'ZIP64 archives are not supported. Re-pack it as a regular ZIP.'],
    'multi-disk': ['不支持分卷 ZIP。', 'Split ZIP archives are not supported.'],
    encrypted: ['压缩包有密码保护，无法导入：', 'The archive is password-protected: '],
    method: ['压缩包用了不支持的压缩方式（只支持「存储」和 Deflate）：', 'Unsupported compression method (only Store and Deflate work): '],
    'unsafe-path': ['压缩包里有不安全的路径：', 'The archive contains an unsafe path: '],
    'too-large': ['内容太大，已停止导入：', 'Too large to import: '],
    'too-many': ['压缩包里的文件太多：', 'Too many files in the archive: '],
    'no-game': ['没有找到 System/Apps 下的游戏目录。这个 ZIP 可能不是 N-Gage 卡带转储；.sis / .sisx 请用「安装 SIS 程序包」，.n-gage 请在「文件管理」上传到 E:\\n-gage\\。',
      'No game folder found under System/Apps. This ZIP may not be an N-Gage card dump; install .sis / .sisx with “Install SIS package”, and upload .n-gage files to E:\\n-gage\\ in the file manager.'],
    'multiple-games': ['System/Apps 下有多个游戏目录，一次只能导入一张卡带：', 'More than one game folder under System/Apps; import one card at a time: '],
    'no-registration': ['游戏目录里缺少注册文件（.aif）：', 'The game folder has no registration file (.aif): '],
    'bad-registration': ['注册文件已损坏：', 'The registration file is corrupt: '],
    'name-collision': ['压缩包里有只差大小写的同名文件：', 'The archive has files whose names differ only in case: '],
    corrupt: ['压缩包已损坏：', 'The archive is corrupt: '],
    'inflate-unsupported': ['当前浏览器不能解压 ZIP（缺少 DecompressionStream），请更新浏览器。', 'This browser cannot unpack ZIP files (no DecompressionStream). Please update it.'],
    'fs-conflict': ['E 盘上已有同名的文件或目录挡住了卡带内容：', 'A file or folder on drive E: is in the way: '],
    quota: ['浏览器存储空间不足（需要 / 可用 MB）：', 'Not enough browser storage (needed / free MB): '],
    persist: ['文件已写入模拟器，但保存到浏览器存储失败：', 'Files were written to the emulator but could not be saved to browser storage: '],
  };

  const $ = (id) => document.getElementById(id);

  function localized(zh, en) {
    const locale = root.EKA2L1 && root.EKA2L1.getLocale ? root.EKA2L1.getLocale() : (navigator.language || '');
    return String(locale).toLowerCase().indexOf('zh') === 0 ? zh : en;
  }

  function t(key, fallbackZh, fallbackEn) {
    try {
      if (root.EKA2L1 && root.EKA2L1.t) {
        const text = root.EKA2L1.t(key);
        if (text && text !== key) return text;
      }
    } catch { /* 用下面的兜底 */ }
    return localized(fallbackZh, fallbackEn);
  }

  function setStatus(color, text) {
    const dot = $('coreStatusDot');
    const status = $('coreStatusText');
    if (dot) dot.className = 'status-dot ' + color;
    if (status) status.textContent = text;
  }

  function showError(text) {
    const el = $('bootError');
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }

  function toast(text, ms) {
    if (root.EKA2L1 && root.EKA2L1.toast) root.EKA2L1.toast(text, ms || 4000);
  }

  function messageFor(err) {
    if (err instanceof CardError && MESSAGES[err.code]) {
      const [zh, en] = MESSAGES[err.code];
      return localized(zh, en) + (/[:：]\s*$/.test(localized(zh, en)) ? err.detail : '');
    }
    return localized('导入失败：', 'Import failed: ') + ((err && err.message) || String(err));
  }

  // 上游把 coreReady / deviceReady 关在闭包里；它们分别对应启动进度条完成和这个标记
  function libraryState() {
    let hasDevice = false;
    let cachedApps = false;
    try {
      hasDevice = localStorage.getItem('eka2l1_has_device') === '1';
      cachedApps = (JSON.parse(localStorage.getItem('eka2l1_apps_cache') || '[]') || []).length > 0;
    } catch { /* 隐私模式读不到时按没有设备处理 */ }
    const booted = Boolean($('bootProgress') && $('bootProgress').classList.contains('done'));
    const fs = root.EKA2L1 && root.EKA2L1.module && root.EKA2L1.module.FS;
    if (booted && hasDevice && fs) return 'ready';
    if (!booted && (hasDevice || cachedApps)) return 'booting';
    return 'no-device';
  }

  let busy = false;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip,application/x-zip-compressed';
  input.style.display = 'none';
  input.id = 'ngageCardInput';
  document.body.appendChild(input);

  root.pickNgageCard = function () {
    if (busy) { toast(localized('正在导入，请稍候。', 'An import is already running.')); return; }
    const state = libraryState();
    if (state === 'booting') { toast(t('toast.coreBooting', '核心启动中，请稍候…', 'The core is still starting…')); return; }
    if (state === 'no-device') {
      toast(t('toast.installRomFirst', '请先安装设备固件', 'Install device firmware first'));
      if (root.openDeviceSheet) root.openDeviceSheet();
      return;
    }
    input.click();
  };

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) runImport(file);
  });

  async function runImport(file) {
    busy = true;
    showError('');
    const E = root.EKA2L1;
    try {
      const result = await installCard(file, {
        FS: E.module.FS,
        savePaths: E.savePaths ? (paths, onProgress) => E.savePaths(paths, onProgress) : () => E.save(),
        deletePathPrefixes: E.deletePathPrefixes ? (prefixes) => E.deletePathPrefixes(prefixes) : null,
        estimate: navigator.storage && navigator.storage.estimate ? () => navigator.storage.estimate() : null,
        onStage(name, info) {
          if (name === 'read') setStatus('yellow', localized('正在读取卡带转储…', 'Reading the card dump…'));
          else if (name === 'extract') {
            setStatus('yellow', localized('正在解压 ' + (info.done + 1) + '/' + info.total, 'Unpacking ' + (info.done + 1) + '/' + info.total));
          } else if (name === 'write') setStatus('yellow', localized('正在写入 E 盘…', 'Writing to drive E:…'));
          else if (name === 'persist') {
            const mb = info.bytes ? ' ' + Math.floor(info.bytes / 1048576) + ' MB' : '';
            setStatus('yellow', localized('正在保存到浏览器存储…' + mb, 'Saving to browser storage…' + mb));
          }
        },
      });
      const title = result.plan.title || file.name.replace(/\.zip$/i, '');
      try {
        sessionStorage.setItem(IMPORTED_KEY, JSON.stringify({ title, uid: result.plan.appUid }));
      } catch { /* 只影响刷新后的提示 */ }
      setStatus('green', localized('已导入，正在刷新程序列表…', 'Imported; refreshing the app list…'));
      toast(localized('已导入《' + title + '》，正在刷新程序列表…', 'Imported “' + title + '”. Refreshing the app list…'), 3000);
      // 应用列表服务只在核心启动时扫描 System\Apps，重启核心最省事也最稳
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      console.error('[8BitGo] N-Gage 卡带导入失败：', err);
      const text = messageFor(err);
      showError(text);
      setStatus('red', localized('导入失败', 'Import failed'));
      toast(text, 6000);
      busy = false;
    }
  }

  function cardIcon() {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h8l4 4v14H7z"/><path d="M10 3v4M13 3v4"/>'
      + '<path d="M10 13h6M10 17h4"/></svg>';
  }

  function addButtons() {
    const sheetSis = document.querySelector('#installSheetOverlay [data-i18n="sheet.installSis"]');
    const sheetButton = sheetSis && sheetSis.closest('button');
    if (sheetButton && !$('ngageCardSheetItem')) {
      const item = document.createElement('button');
      item.className = 'sheet-item';
      item.id = 'ngageCardSheetItem';
      item.type = 'button';
      item.innerHTML = cardIcon() + '<span></span>';
      item.querySelector('span').textContent = localized('导入 N-Gage 卡带转储（.zip）', 'Import N-Gage card dump (.zip)');
      item.addEventListener('click', () => {
        if (root.closeSheets) root.closeSheets();
        root.pickNgageCard();
      });
      sheetButton.after(item);
    }

    const sisRow = document.querySelector('.section-card .pref-item button[onclick="pickSis()"]');
    const row = sisRow && sisRow.closest('.pref-item');
    if (row && !$('ngageCardRow')) {
      const pref = document.createElement('div');
      pref.className = 'pref-item';
      pref.id = 'ngageCardRow';
      pref.innerHTML = '<div style="flex:1"><div class="pref-label"></div><div class="pref-sub"></div></div>'
        + '<button class="btn" type="button"></button>';
      pref.querySelector('.pref-label').textContent = localized('导入 N-Gage 卡带转储', 'Import N-Gage card dump');
      pref.querySelector('.pref-sub').textContent = localized(
        '.zip，内含 System/Apps 的卡带目录，复制到 E 盘',
        '.zip containing the card’s System/Apps tree; copied to drive E:');
      const button = pref.querySelector('button');
      button.textContent = t('action.chooseFile', '选择文件', 'Choose file');
      button.addEventListener('click', () => root.pickNgageCard());
      row.after(pref);
    }
  }

  function announceImported() {
    let record = null;
    try {
      record = JSON.parse(sessionStorage.getItem(IMPORTED_KEY) || 'null');
      sessionStorage.removeItem(IMPORTED_KEY);
    } catch { return; }
    if (!record || !record.title) return;
    const deadline = Date.now() + 120000;
    (function poll() {
      if (libraryState() !== 'ready') {
        if (Date.now() < deadline) setTimeout(poll, 500);
        return;
      }
      let listed = false;
      try {
        listed = root.EKA2L1.appList().some((app) => (app.uid >>> 0) === (record.uid >>> 0));
      } catch { listed = false; }
      if (listed) {
        toast(localized('《' + record.title + '》已出现在程序列表中，点开即可运行。',
          '“' + record.title + '” is now in the app list.'), 5000);
      } else {
        const text = localized(
          '《' + record.title + '》的文件已复制到 E 盘，但程序列表里没有出现它。当前设备固件可能不是 N-Gage，或模拟器暂不支持这款游戏。',
          'The files for “' + record.title + '” were copied to drive E:, but it did not show up in the app list. '
            + 'The installed firmware may not be an N-Gage, or the emulator may not support this game yet.');
        showError(text);
        toast(text, 6000);
      }
    })();
  }

  addButtons();
  announceImported();
})(typeof globalThis !== 'undefined' ? globalThis : this);
