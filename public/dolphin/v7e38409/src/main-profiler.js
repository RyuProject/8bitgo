// §28cx main-thread profiler. The worker-only run-loop probe
// (tools/_probe-runloop.mjs) cannot see main-thread contention, yet that
// is exactly where real-Chrome audio underruns are born: the audio pump is
// a setInterval(15ms) on the main thread, and the rAF loop + worker→main
// message handlers share that same thread. When the main thread is blocked
// (long script, style/layout, GC, compositor) BOTH the rAF loop and the
// audio setInterval miss their slots → the AudioContext schedule runs dry →
// underrun. The pre-existing stall loggers (core-host loop, worker handler)
// only fire on a single callback running >20ms; they miss the GAPS between
// callbacks (the actual starvation) and don't attribute WHICH callback ate
// the time.
//
// This profiler measures, in the real browser:
//   1. Long Animation Frames (LoAF, Chrome 123+) with per-script attribution
//      — the authoritative "what blocked the main thread and for how long",
//      broken down by invoker (rAF loop, setInterval audio pump, worker
//      message handler, etc.) and by style/layout/render cost.
//   2. rAF cadence — the gap between animation frames as the page actually
//      experiences it. Gaps ≫ 16.7ms mean a missed vsync.
//   3. Audio pump cadence + mixAudio round-trip latency — read from the live
//      AudioController (window.__audio.profile). Distinguishes "setInterval
//      starved on main thread" from "worker slow to answer mixAudio".
//
// Activated only with ?mainprof=1 (zero cost otherwise). Results stream to
// the console every PRINT_INTERVAL_MS and to an on-page HUD for screenshots;
// window.__mainProfile.summary() returns the structured snapshot so the
// Playwright validator can read it too.

const PRINT_INTERVAL_MS = 5000;
const HUD_INTERVAL_MS = 1000;
// LoAF only reports frames whose duration crosses the spec floor (50ms); we
// additionally tag frames over one/two 60Hz budgets for the summary buckets.
const FRAME_BUDGET_MS = 1000 / 60;

function isEnabled() {
  return new URLSearchParams(window.location.search).get("mainprof") === "1";
}

// Collapse a PerformanceScriptTiming to a stable attribution key. invokerType
// tells us the callback class (user-callback for setInterval/setTimeout,
// event-listener, etc.); sourceURL+sourceFunctionName pin the actual code.
function scriptKey(script) {
  const invoker = script.invoker || script.invokerType || "unknown";
  const fn = script.sourceFunctionName ? `#${script.sourceFunctionName}` : "";
  const url = script.sourceURL ? shortUrl(script.sourceURL) : "";
  return `${invoker}${fn}${url ? ` (${url})` : ""}`;
}

function shortUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    return u.pathname.split("/").pop() || u.pathname;
  } catch {
    return url.length > 40 ? "…" + url.slice(-37) : url;
  }
}

export class MainThreadProfiler {
  constructor() {
    this.enabled = isEnabled();
    this.startedAt = performance.now();

    // LoAF aggregates.
    this.loafCount = 0;
    this.loafTotalMs = 0;
    this.loafBlockingMs = 0;
    this.loafMaxMs = 0;
    this.loafMaxAt = 0;
    this.loafStyleLayoutMs = 0;
    this.loafOver33 = 0; // frames > 2× the 60Hz budget
    this.scriptStats = new Map(); // key → {totalMs, count, maxMs}
    this.loafSupported = false;
    this.longtaskFallback = false;
    this.longtaskCount = 0;
    this.longtaskTotalMs = 0;
    this.longtaskMaxMs = 0;

    // rAF cadence aggregates.
    this.rafFrames = 0;
    this.rafLastTs = 0;
    this.rafGapSumMs = 0;
    this.rafGapMaxMs = 0;
    this.rafGapOver33 = 0; // dropped ≥1 vsync
    this.rafGapOver100 = 0; // a visible hitch
    this.rafGapBuckets = new Int32Array(6); // <17, <25, <34, <50, <100, ≥100

    this._observers = [];
    this._rafId = 0;
    this._printTimer = 0;
    this._hud = null;
    this._hudTimer = 0;
  }

  start() {
    if (!this.enabled) {
      return;
    }
    this._observeLoaf();
    this._startRafCadence();
    this._createHud();
    this._printTimer = window.setInterval(() => this._printSummary(), PRINT_INTERVAL_MS);
    this._hudTimer = window.setInterval(() => this._renderHud(), HUD_INTERVAL_MS);
    // eslint-disable-next-line no-console
    console.log(
      `[mainprof] enabled. LoAF=${this.loafSupported ? "yes" : this.longtaskFallback ? "longtask-fallback" : "unsupported"}. ` +
        `Console summary every ${PRINT_INTERVAL_MS / 1000}s; window.__mainProfile.summary() for a snapshot.`
    );
  }

  _observeLoaf() {
    const supported =
      typeof PerformanceObserver === "function" &&
      Array.isArray(PerformanceObserver.supportedEntryTypes);
    const types = supported ? PerformanceObserver.supportedEntryTypes : [];

    if (types.includes("long-animation-frame")) {
      this.loafSupported = true;
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this._recordLoaf(entry);
        }
      });
      try {
        obs.observe({ type: "long-animation-frame", buffered: true });
        this._observers.push(obs);
        return;
      } catch (err) {
        this.loafSupported = false;
        console.warn("[mainprof] LoAF observe failed, falling back to longtask:", err);
      }
    }

    if (types.includes("longtask")) {
      this.longtaskFallback = true;
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longtaskCount += 1;
          this.longtaskTotalMs += entry.duration;
          if (entry.duration > this.longtaskMaxMs) this.longtaskMaxMs = entry.duration;
          // Attribute via the limited longtask container/attribution.
          const attr = entry.attribution?.[0];
          const key = attr
            ? `${attr.name || "task"} (${shortUrl(attr.containerSrc || attr.containerName || "")})`
            : "longtask";
          this._bumpScript(key, entry.duration);
        }
      });
      try {
        obs.observe({ type: "longtask", buffered: true });
        this._observers.push(obs);
      } catch (err) {
        console.warn("[mainprof] longtask observe failed:", err);
      }
    }
  }

  _recordLoaf(entry) {
    this.loafCount += 1;
    this.loafTotalMs += entry.duration;
    this.loafBlockingMs += entry.blockingDuration || 0;
    if (entry.duration > this.loafMaxMs) {
      this.loafMaxMs = entry.duration;
      this.loafMaxAt = entry.startTime;
    }
    if (entry.duration > 2 * FRAME_BUDGET_MS) this.loafOver33 += 1;
    // styleAndLayoutStart marks where rendering work began within the frame;
    // the tail from there to the end is style/layout/paint cost.
    if (Number.isFinite(entry.styleAndLayoutStart) && entry.styleAndLayoutStart > 0) {
      this.loafStyleLayoutMs += Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart);
    }
    for (const script of entry.scripts || []) {
      this._bumpScript(scriptKey(script), script.duration || 0, script.forcedStyleAndLayoutDuration || 0);
    }
  }

  _bumpScript(key, durationMs, forcedLayoutMs = 0) {
    let s = this.scriptStats.get(key);
    if (!s) {
      s = { totalMs: 0, count: 0, maxMs: 0, forcedLayoutMs: 0 };
      this.scriptStats.set(key, s);
    }
    s.totalMs += durationMs;
    s.count += 1;
    s.forcedLayoutMs += forcedLayoutMs;
    if (durationMs > s.maxMs) s.maxMs = durationMs;
  }

  _startRafCadence() {
    const tick = (ts) => {
      if (this.rafLastTs) {
        const gap = ts - this.rafLastTs;
        this.rafFrames += 1;
        this.rafGapSumMs += gap;
        if (gap > this.rafGapMaxMs) this.rafGapMaxMs = gap;
        if (gap > 2 * FRAME_BUDGET_MS) this.rafGapOver33 += 1;
        if (gap > 100) this.rafGapOver100 += 1;
        const b =
          gap < 17 ? 0 : gap < 25 ? 1 : gap < 34 ? 2 : gap < 50 ? 3 : gap < 100 ? 4 : 5;
        this.rafGapBuckets[b] += 1;
      }
      this.rafLastTs = ts;
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _audio() {
    const p = window.__audio?.profile;
    if (!p || !p.gapSamples) {
      return null;
    }
    return {
      pumpCount: p.pumpCount,
      misses: p.pumpMisses,
      avgGapMs: p.sumGapMs / p.gapSamples,
      maxGapMs: p.maxGapMs,
      avgMixMs: p.mixSamples ? p.sumMixMs / p.mixSamples : 0,
      maxMixMs: p.maxMixMs,
      underruns: p.underrunCount || 0,
      overruns: p.overrunCount || 0,
      leadSeconds: p.scheduleLeadSeconds || 0,
      driftSeconds: p.scheduleDriftSeconds || 0
    };
  }

  // The existing >20ms stall loggers on the host (rAF loop) and worker
  // adapter (worker→main message handler) cover the 33-50ms band that LoAF's
  // 50ms floor cannot see. Reading their counters lets us attribute the
  // pump-starving medium stalls to JS (loop/message handler) vs non-JS
  // (GC/compositor/raster — which show up as rAF gaps with NO matching JS
  // stall, and can only be escaped via AudioWorklet, not trimmed).
  _hostStalls() {
    const host = window.__host;
    if (!host) return null;
    const loop = host._mainStallCount || 0;
    const loopWorst = host._mainStallWorstMs || 0;
    const sab = host._sabStallCount || 0;
    const sabWorst = host._sabStallWorstMs || 0;
    const msg = host.adapter?._msgStallCount || 0;
    const msgWorst = host.adapter?._msgStallWorstMs || 0;
    const jsTotal = loop + sab + msg;
    return {
      loop, loopWorst, sab, sabWorst, msg, msgWorst, jsTotal,
      // How many of the rAF >33ms gaps are explained by a JS stall. A big
      // shortfall (rafOver33 ≫ jsTotal) means the stalls are non-JS.
      rafOver33: this.rafGapOver33,
      jsExplainsPct: this.rafGapOver33 > 0 ? Math.min(100, (jsTotal / this.rafGapOver33) * 100) : 0
    };
  }

  topScripts(n = 5) {
    return [...this.scriptStats.entries()]
      .map(([key, s]) => ({ key, ...s }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, n);
  }

  summary() {
    const elapsedS = (performance.now() - this.startedAt) / 1000;
    const audio = this._audio();
    const frame = window.__lastFrameInfo || {};
    const helper = String(frame.ppcWasmHelperStats || "");
    const causal = frame.causalTelemetry || window.__causalTelemetry || null;
    const under = causal?.presentation?.underrunCount ?? /\bunderrun:(\d+)/.exec(helper)?.[1] ?? "?";
    const drop = causal?.presentation?.droppedFrameCount ?? /\bdrop:(\d+)/.exec(helper)?.[1] ?? "?";
    return {
      elapsedS,
      loaf: this.loafSupported
        ? {
            count: this.loafCount,
            totalMs: this.loafTotalMs,
            blockingMs: this.loafBlockingMs,
            maxMs: this.loafMaxMs,
            over33: this.loafOver33,
            styleLayoutMs: this.loafStyleLayoutMs,
            // % of wall-clock the main thread spent inside long frames
            busyPct: elapsedS > 0 ? (this.loafTotalMs / (elapsedS * 1000)) * 100 : 0
          }
        : null,
      longtask: this.longtaskFallback
        ? { count: this.longtaskCount, totalMs: this.longtaskTotalMs, maxMs: this.longtaskMaxMs }
        : null,
      raf: {
        frames: this.rafFrames,
        avgGapMs: this.rafFrames ? this.rafGapSumMs / this.rafFrames : 0,
        maxGapMs: this.rafGapMaxMs,
        over33: this.rafGapOver33,
        over100: this.rafGapOver100,
        effectiveFps: this.rafFrames ? 1000 / (this.rafGapSumMs / this.rafFrames) : 0,
        buckets: Array.from(this.rafGapBuckets)
      },
      audio,
      presentationQueue: { underrun: under, drop },
      causalTelemetry: causal,
      hostStalls: this._hostStalls(),
      topScripts: this.topScripts(6)
    };
  }

  _printSummary() {
    const s = this.summary();
    const lines = [`[mainprof] +${s.elapsedS.toFixed(0)}s ============================`];
    if (s.loaf) {
      lines.push(
        `  LoAF: ${s.loaf.count} frames, busy=${s.loaf.busyPct.toFixed(1)}% of wall, ` +
          `total=${s.loaf.totalMs.toFixed(0)}ms blocking=${s.loaf.blockingMs.toFixed(0)}ms ` +
          `max=${s.loaf.maxMs.toFixed(0)}ms over33=${s.loaf.over33} styleLayout=${s.loaf.styleLayoutMs.toFixed(0)}ms`
      );
    } else if (s.longtask) {
      lines.push(
        `  longtask(fallback): ${s.longtask.count} tasks total=${s.longtask.totalMs.toFixed(0)}ms max=${s.longtask.maxMs.toFixed(0)}ms`
      );
    } else {
      lines.push("  LoAF/longtask: UNSUPPORTED in this browser");
    }
    lines.push(
      `  rAF: ${s.raf.effectiveFps.toFixed(1)} eff-fps, avgGap=${s.raf.avgGapMs.toFixed(1)}ms ` +
        `maxGap=${s.raf.maxGapMs.toFixed(0)}ms over33=${s.raf.over33} over100=${s.raf.over100} ` +
        `[<17:${s.raf.buckets[0]} <25:${s.raf.buckets[1]} <34:${s.raf.buckets[2]} <50:${s.raf.buckets[3]} <100:${s.raf.buckets[4]} ≥100:${s.raf.buckets[5]}]`
    );
    if (s.audio) {
      lines.push(
        `  audio-pump: ${s.audio.pumpCount} calls, misses=${s.audio.misses} ` +
          `avgGap=${s.audio.avgGapMs.toFixed(1)}ms maxGap=${s.audio.maxGapMs.toFixed(0)}ms | ` +
          `mixAudio avg=${s.audio.avgMixMs.toFixed(1)}ms max=${s.audio.maxMixMs.toFixed(0)}ms`
      );
    } else {
      lines.push("  audio-pump: no samples yet (unmute + be in-game for data)");
    }
    lines.push(
      `  presentation queue: ${s.presentationQueue.underrun} underruns / ` +
        `${s.presentationQueue.drop} drops`
    );
    if (s.hostStalls) {
      const h = s.hostStalls;
      lines.push(
        `  >20ms JS stalls: loop=${h.loop}(max${h.loopWorst.toFixed(0)}) ` +
          `msg=${h.msg}(max${h.msgWorst.toFixed(0)}) sab=${h.sab}(max${h.sabWorst.toFixed(0)}) ` +
          `| rAF>33=${h.rafOver33}, JS explains ${h.jsExplainsPct.toFixed(0)}% ` +
          `→ ${h.jsExplainsPct < 40 ? "STALLS ARE NON-JS (GC/compositor) — AudioWorklet" : "STALLS ARE JS — attributable"}`
      );
    }
    lines.push("  top main-thread time eaters:");
    for (const t of s.topScripts) {
      lines.push(
        `    ${t.totalMs.toFixed(0)}ms (${t.count}× max ${t.maxMs.toFixed(0)}ms` +
          `${t.forcedLayoutMs > 1 ? `, forcedLayout ${t.forcedLayoutMs.toFixed(0)}ms` : ""}) — ${t.key}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }

  _createHud() {
    const hud = document.createElement("pre");
    hud.id = "main-profiler-hud";
    Object.assign(hud.style, {
      position: "fixed",
      bottom: "8px",
      left: "8px",
      maxWidth: "560px",
      maxHeight: "55vh",
      overflow: "hidden",
      padding: "8px 10px",
      background: "rgba(0,0,0,0.85)",
      color: "#7cf",
      font: "11px/1.35 ui-monospace,Menlo,Consolas,monospace",
      zIndex: 99998,
      pointerEvents: "none",
      whiteSpace: "pre",
      border: "1px solid #36c",
      borderRadius: "4px"
    });
    hud.textContent = "[mainprof] warming up…";
    document.body.appendChild(hud);
    this._hud = hud;
  }

  _renderHud() {
    if (!this._hud) return;
    const s = this.summary();
    const rows = [`MAIN-THREAD PROFILER  +${s.elapsedS.toFixed(0)}s`];
    if (s.loaf) {
      rows.push(
        `LoAF busy ${s.loaf.busyPct.toFixed(1)}%  blk ${s.loaf.blockingMs.toFixed(0)}ms  max ${s.loaf.maxMs.toFixed(0)}ms  >33:${s.loaf.over33}`
      );
    } else if (s.longtask) {
      rows.push(`longtask ${s.longtask.count}  ${s.longtask.totalMs.toFixed(0)}ms  max ${s.longtask.maxMs.toFixed(0)}ms`);
    }
    rows.push(`rAF ${s.raf.effectiveFps.toFixed(0)}fps gap avg ${s.raf.avgGapMs.toFixed(0)} max ${s.raf.maxGapMs.toFixed(0)}  >33:${s.raf.over33} >100:${s.raf.over100}`);
    if (s.audio) {
      rows.push(
        `pump miss ${s.audio.misses}/${s.audio.pumpCount} gap avg ${s.audio.avgGapMs.toFixed(0)} max ${s.audio.maxGapMs.toFixed(0)}`
      );
      rows.push(`mixAudio avg ${s.audio.avgMixMs.toFixed(1)} max ${s.audio.maxMixMs.toFixed(0)}ms`);
    } else {
      rows.push("pump: unmute + play for data");
    }
    rows.push(
      `queue ${s.presentationQueue.underrun} underruns / ${s.presentationQueue.drop} drops`
    );
    if (s.hostStalls) {
      const h = s.hostStalls;
      rows.push(`>20ms JS: loop ${h.loop} msg ${h.msg} sab ${h.sab}  (rAF>33 ${h.rafOver33})`);
      rows.push(h.jsExplainsPct < 40 ? "→ stalls NON-JS (GC/compositor)" : "→ stalls are JS-attributable");
    }
    rows.push("top eaters:");
    for (const t of s.topScripts.slice(0, 4)) {
      rows.push(`  ${t.totalMs.toFixed(0)}ms ${t.key}`);
    }
    this._hud.textContent = rows.join("\n");
  }

  stop() {
    for (const o of this._observers) {
      try { o.disconnect(); } catch {}
    }
    this._observers = [];
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._printTimer) clearInterval(this._printTimer);
    if (this._hudTimer) clearInterval(this._hudTimer);
  }
}

export function startMainThreadProfiler() {
  const profiler = new MainThreadProfiler();
  if (!profiler.enabled) {
    return null;
  }
  window.__mainProfile = profiler;
  profiler.start();
  return profiler;
}
