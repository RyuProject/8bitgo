const DEFAULT_CORE_URL = "./cores/dolphin/dolphin.js";

export async function dolphinBundleAvailable(coreUrl = DEFAULT_CORE_URL) {
  try {
    const response = await fetch(coreUrl, {
      method: "HEAD",
      cache: "no-store"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class DolphinCoreAdapter {
  constructor({ canvas, coreUrl = DEFAULT_CORE_URL, onStatus = () => {} } = {}) {
    this.canvas = canvas;
    this.coreUrl = coreUrl;
    this.onStatus = onStatus;
    this.module = null;
    this.api = null;
    this.loaded = false;
    this.width = 640;
    this.height = 480;
  }

  async load() {
    const factory = await this.loadFactory();
    const coreUrl = this.resolveCoreUrl();
    this.module = await factory({
      canvas: this.canvas,
      noInitialRun: true,
      locateFile: (path) => new URL(path, coreUrl).href,
      print: (message) => this.onStatus(String(message)),
      printErr: (message) => this.onStatus(String(message))
    });
    this.api = this.bindApi(this.module);
    this.width = this.api.frameWidth();
    this.height = this.api.frameHeight();
    this.loaded = true;
    return this.module;
  }

  async loadFactory() {
    const coreUrl = this.resolveCoreUrl();

    try {
      const module = await import(coreUrl);
      const factory = module.default ?? module.createDolphinCore ?? window.createDolphinCore;
      if (typeof factory === "function") {
        return factory;
      }
    } catch {
      await this.injectClassicScript();
      if (typeof window.createDolphinCore === "function") {
        return window.createDolphinCore;
      }
      if (typeof window.Module === "function") {
        return window.Module;
      }
      if (window.Module && typeof window.Module === "object") {
        return async () => window.Module;
      }
    }

    throw new Error("Dolphin bundle did not expose an Emscripten factory");
  }

  injectClassicScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = this.resolveCoreUrl();
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Unable to load ${this.coreUrl}`));
      document.head.append(script);
    });
  }

  resolveCoreUrl() {
    return new URL(this.coreUrl, window.location.href).href;
  }

  bindApi(module) {
    const cwrap = module.cwrap?.bind(module);
    const ccall = module.ccall?.bind(module);

    const wrap = (name, returnType, argTypes) => {
      if (cwrap) {
        return cwrap(name, returnType, argTypes);
      }

      const raw = module[`_${name}`];
      if (typeof raw !== "function") {
        throw new Error(`Dolphin core missing export ${name}`);
      }
      return raw.bind(module);
    };

    return {
      mountDisc: ccall
        ? (path) => ccall("MountDisc", "number", ["string"], [path])
        : wrap("MountDisc", "number", ["number"]),
      reset: wrap("Reset", null, []),
      setInputMask: wrap("SetInputMask", null, ["number"]),
      runFrame: wrap("RunFrame", null, []),
      frameWidth: wrap("FrameWidth", "number", []),
      frameHeight: wrap("FrameHeight", "number", []),
      frameBuffer: wrap("FrameBuffer", "number", []),
      saveState: wrap("SaveState", "number", ["number"]),
      loadState: wrap("LoadState", "number", ["number"]),
      getFrame: wrap("GetFrame", "number", []),
      getGameId: wrap("GetGameId", "string", []),
      getGameTitle: wrap("GetGameTitle", "string", [])
    };
  }

  async mountGame(file) {
    if (!this.loaded || !this.module) {
      await this.load();
    }

    if (!this.module.FS) {
      throw new Error("Dolphin core does not expose an Emscripten FS mount path");
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_");
    const path = `/games/${safeName}`;

    try {
      this.module.FS.mkdir("/games");
    } catch {
      // Directory may already exist.
    }

    this.module.FS.writeFile(path, data);

    const mounted = this.api.mountDisc(path);
    if (!mounted) {
      throw new Error("Dolphin core rejected the selected disc");
    }

    return {
      path,
      gameId: this.api.getGameId(),
      title: this.api.getGameTitle()
    };
  }

  setInputMask(mask) {
    this.api?.setInputMask(mask >>> 0);
  }

  runFrame() {
    this.api?.runFrame();
  }

  readFrameRgba() {
    if (!this.module || !this.api) {
      return null;
    }

    const pointer = this.api.frameBuffer();
    const length = this.width * this.height * 4;
    return new Uint8ClampedArray(this.module.HEAPU8.buffer, pointer, length);
  }

  start() {
    this.module?.resumeMainLoop?.();
  }

  pause() {
    this.module?.pauseMainLoop?.();
  }

  reset() {
    this.api?.reset();
  }

  saveState(slot) {
    this.api?.saveState(slot);
  }

  loadState(slot) {
    this.api?.loadState(slot);
  }
}
