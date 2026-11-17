const QUERY_KEY = "wgpu-synthetic";
const SCHEMA = "wasm-dolphin.wgpu-synthetic.v1";
const SCHEMA_REVISION = 2;
const DIAGNOSTIC_SIZE = 64;
const COMMAND_RECORD_BYTES = 32;

const VALID_MODES = new Set(["route", "clear", "static-triangle", "checker", "command-ring", "all"]);

export const SYNTHETIC_WGPU_COMMAND_OP = Object.freeze({
  CLEAR: 1,
  DRAW_TEST: 4
});

export const SYNTHETIC_COLORS = Object.freeze({
  clear: Object.freeze([26, 77, 153, 255]),
  background: Object.freeze([13, 20, 31, 255]),
  triangle: Object.freeze([230, 89, 64, 255]),
  checkerA: Object.freeze([223, 31, 142, 255]),
  checkerB: Object.freeze([28, 199, 216, 255])
});

const LIMIT_NAMES = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderComponents",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension"
];

export function readWebGpuSyntheticRequest(search) {
  const params = new URLSearchParams(search);
  if (!params.has(QUERY_KEY)) {
    return null;
  }

  const rawMode = (params.get(QUERY_KEY) || "all").trim().toLowerCase();
  const mode = rawMode === "triangle" ? "static-triangle" : rawMode;
  return {
    autoExport: params.get("wgpu-export") === "1",
    mode,
    outputPath: params.get("diag-output") || "",
    presenter: (params.get("presenter") || "webgpu").trim().toLowerCase(),
    provenance: {
      repo: {
        commit: params.get("diag-repo-commit") || "unknown",
        dirty: parseDirty(params.get("diag-repo-dirty"))
      },
      core: {
        id: params.get("diag-core-id") || "none-js-only",
        sha256: params.get("diag-core-sha256") || "none-js-only"
      }
    },
    rawMode,
    valid: VALID_MODES.has(mode)
  };
}

export async function runWebGpuSyntheticPage({
  request,
  documentRef = globalThis.document,
  globalRef = globalThis
}) {
  const canvas = documentRef?.querySelector?.("#screen");
  const status = documentRef?.querySelector?.("#statusPill");
  const coreLabel = documentRef?.querySelector?.("#coreLabel");
  const gameTitle = documentRef?.querySelector?.("#gameTitle");
  const mountNote = documentRef?.querySelector?.("#mountNote");
  const adapterStatus = documentRef?.querySelector?.("#adapterStatus");
  const screenHud = documentRef?.querySelector?.("#screenHud");

  if (status) status.textContent = "WGPU diagnostic";
  if (coreLabel) coreLabel.textContent = "JS-only WebGPU synthetic route";
  if (gameTitle) gameTitle.textContent = `WebGPU synthetic: ${request.mode}`;
  if (mountNote) mountNote.textContent = "No Dolphin core or real draw commands are active.";
  if (adapterStatus) adapterStatus.textContent = "Probing";
  if (screenHud) screenHud.hidden = true;

  const result = await runWebGpuSyntheticDiagnostics({
    request,
    canvas,
    documentRef,
    gpu: globalRef.navigator?.gpu,
    constants: globalRef,
    locationHref: globalRef.location?.href || "",
    userAgent: globalRef.navigator?.userAgent || ""
  });

  globalRef.__wgpuSyntheticDiagnostics = result;
  globalRef.__exportWgpuSyntheticDiagnostics = () =>
    downloadWebGpuSyntheticEvidence(result, { documentRef });
  if (status) {
    status.textContent = result.status === "pass" ? "WGPU diagnostic pass" : "WGPU diagnostic fail";
    status.classList.toggle("error", result.status !== "pass");
  }
  if (adapterStatus) adapterStatus.textContent = result.status === "pass" ? "Synthetic pass" : result.classifier.code;
  if (mountNote) mountNote.textContent = result.classifier.marker;
  appendEvidenceSummary(documentRef, result);
  if (request.autoExport) {
    globalRef.__exportWgpuSyntheticDiagnostics();
  }
  return result;
}

export async function runWebGpuSyntheticDiagnostics({
  request,
  canvas,
  documentRef = globalThis.document,
  gpu = globalThis.navigator?.gpu,
  constants = globalThis,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  wallNow = () => Date.now(),
  locationHref = globalThis.location?.href || "",
  userAgent = globalThis.navigator?.userAgent || ""
}) {
  const startedAt = now();
  const startedAtUtc = new Date(wallNow()).toISOString();
  const runId = `wgpu-synthetic-${startedAtUtc.replaceAll(":", "").replaceAll(".", "-")}`;
  const suggestedDirectory = request?.outputPath || `.omx/wgpu-synthetic/${runId}`;
  const evidence = {
    schema: SCHEMA,
    schemaRevision: SCHEMA_REVISION,
    status: "running",
    startedAtUtc,
    attribution: {
      url: String(locationHref || ""),
      browser: {
        userAgent: String(userAgent || ""),
        chromeVersion: chromeVersion(userAgent)
      },
      repo: { ...request?.provenance?.repo },
      core: { ...request?.provenance?.core }
    },
    output: {
      runId,
      suggestedDirectory,
      rawEvidencePath: `${suggestedDirectory}/evidence.json`,
      exportFunction: "window.__exportWgpuSyntheticDiagnostics()"
    },
    request: { ...request },
    route: {
      requested: true,
      presenter: request?.presenter || "",
      gpuAvailable: Boolean(gpu)
    },
    deviceLoss: { status: "not-observed" },
    uncapturedErrors: [],
    cleanup: {
      uncapturedListenerAdded: false,
      uncapturedListenerRemoved: false
    },
    tests: [],
    markers: [],
    classifier: {
      status: "running",
      code: "RUNNING",
      stage: "route",
      marker: "WGPU_SYNTHETIC_CLASSIFIER:RUNNING"
    }
  };

  const mark = (marker) => {
    evidence.markers.push(marker);
    console.info(`[wgpu-synthetic] ${marker}`);
  };

  if (!request?.valid) {
    return fail(evidence, mark, "INVALID_QUERY", "route", `Unsupported ${QUERY_KEY} mode: ${request?.rawMode || ""}`, startedAt, now, wallNow);
  }
  if (request.presenter !== "webgpu" && request.presenter !== "wgpu") {
    return fail(evidence, mark, "PRESENTER_ROUTE_MISMATCH", "route", "Synthetic diagnostics require presenter=webgpu", startedAt, now, wallNow);
  }
  if (!canvas?.getContext) {
    return fail(evidence, mark, "CANVAS_UNAVAILABLE", "context", "#screen canvas is unavailable", startedAt, now, wallNow);
  }
  if (!gpu?.requestAdapter) {
    return fail(evidence, mark, "WEBGPU_API_UNAVAILABLE", "route", "navigator.gpu is unavailable", startedAt, now, wallNow);
  }

  const requiredConstants = ["GPUTextureUsage", "GPUBufferUsage", "GPUMapMode"];
  const missingConstants = requiredConstants.filter((name) => !constants?.[name]);
  if (missingConstants.length > 0) {
    return fail(evidence, mark, "WEBGPU_CONSTANTS_UNAVAILABLE", "route", missingConstants.join(", "), startedAt, now, wallNow);
  }

  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (error) {
    return fail(evidence, mark, "ADAPTER_REQUEST_FAILED", "adapter", messageOf(error), startedAt, now, wallNow);
  }
  if (!adapter) {
    return fail(evidence, mark, "ADAPTER_UNAVAILABLE", "adapter", "requestAdapter returned null", startedAt, now, wallNow);
  }

  evidence.route.adapter = {
    info: await adapterInfo(adapter),
    features: sortedFeatures(adapter.features),
    limits: supportedLimits(adapter.limits)
  };
  mark("WGPU_SYNTHETIC_ADAPTER:PASS");

  let device;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    return fail(evidence, mark, "DEVICE_REQUEST_FAILED", "device", messageOf(error), startedAt, now, wallNow);
  }

  evidence.route.device = {
    features: sortedFeatures(device.features),
    limits: supportedLimits(device.limits)
  };
  mark("WGPU_SYNTHETIC_DEVICE:PASS");

  device.lost?.then((info) => {
    evidence.deviceLoss = {
      status: "lost",
      reason: String(info?.reason || "unknown"),
      message: String(info?.message || "")
    };
    mark(`WGPU_SYNTHETIC_DEVICE_LOST:${evidence.deviceLoss.reason}`);
  });

  const uncapturedHandler = (event) => {
    evidence.uncapturedErrors.push(serializeGpuError(event?.error || event));
    mark("WGPU_SYNTHETIC_UNCAPTURED_ERROR");
  };
  device.addEventListener?.("uncapturederror", uncapturedHandler);
  evidence.cleanup.uncapturedListenerAdded = typeof device.addEventListener === "function";

  try {
    const context = canvas.getContext("webgpu");
    if (!context) {
      return fail(evidence, mark, "CONTEXT_UNAVAILABLE", "context", "canvas.getContext('webgpu') returned null", startedAt, now, wallNow);
    }

    const format = typeof gpu.getPreferredCanvasFormat === "function" ? gpu.getPreferredCanvasFormat() : "bgra8unorm";
    if (format !== "bgra8unorm" && format !== "rgba8unorm") {
      return fail(evidence, mark, "UNSUPPORTED_CANVAS_FORMAT", "context", format, startedAt, now, wallNow);
    }

    const previousSize = { width: canvas.width, height: canvas.height };
    canvas.width = DIAGNOSTIC_SIZE;
    canvas.height = DIAGNOSTIC_SIZE;
    const usage = constants.GPUTextureUsage.RENDER_ATTACHMENT | constants.GPUTextureUsage.COPY_SRC;
    try {
      context.configure({ device, format, alphaMode: "opaque", usage });
    } catch (error) {
      return fail(evidence, mark, "CONTEXT_CONFIGURE_FAILED", "context", messageOf(error), startedAt, now, wallNow);
    }

    evidence.route.context = {
      format,
      alphaMode: "opaque",
      usage,
      previousSize,
      diagnosticSize: { width: canvas.width, height: canvas.height }
    };
    mark("WGPU_SYNTHETIC_CONTEXT:PASS");
    mark("WGPU_SYNTHETIC_ROUTE:PASS");

    const options = { device, context, format, constants, documentRef, now };
    const selected = request.mode === "all"
      ? ["command-ring", "checker"]
      : request.mode === "route"
        ? []
        : [request.mode];
    for (const name of selected) {
      if (name === "command-ring") {
        const commandRing = await runSyntheticCommandRing(options);
        evidence.commandRing = commandRing.evidence;
        for (const result of commandRing.results) {
          evidence.tests.push(result);
          mark(`WGPU_SYNTHETIC_${result.name.toUpperCase().replaceAll("-", "_")}:${result.status.toUpperCase()}`);
        }
        continue;
      }

      const result = await runOneDiagnostic({ name, ...options });
      evidence.tests.push(result);
      mark(`WGPU_SYNTHETIC_${name.toUpperCase().replaceAll("-", "_")}:${result.status.toUpperCase()}`);
    }

    const failedTest = evidence.tests.find((test) => test.status !== "pass");
    if (failedTest) {
      return fail(evidence, mark, failedTest.code, failedTest.stage, failedTest.error || "Expected output mismatch", startedAt, now, wallNow);
    }
    if (evidence.uncapturedErrors.length > 0) {
      return fail(evidence, mark, "UNCAUGHT_GPU_ERROR", "error", evidence.uncapturedErrors[0].message, startedAt, now, wallNow);
    }
    if (evidence.deviceLoss.status === "lost") {
      return fail(evidence, mark, "DEVICE_LOST", "completion", evidence.deviceLoss.message, startedAt, now, wallNow);
    }

    evidence.status = "pass";
    evidence.elapsedMs = roundMs(now() - startedAt);
    evidence.finishedAtUtc = new Date(wallNow()).toISOString();
    updateOutputManifest(evidence);
    evidence.classifier = {
      status: "pass",
      code: "PASS",
      stage: "complete",
      marker: "WGPU_SYNTHETIC_CLASSIFIER:PASS"
    };
    mark(evidence.classifier.marker);
    return evidence;
  } catch (error) {
    return fail(
      evidence,
      mark,
      error?.code || "UNEXPECTED_DIAGNOSTIC_ERROR",
      error?.stage || "diagnostic",
      messageOf(error),
      startedAt,
      now,
      wallNow
    );
  } finally {
    try {
      device.removeEventListener?.("uncapturederror", uncapturedHandler);
      evidence.cleanup.uncapturedListenerRemoved =
        evidence.cleanup.uncapturedListenerAdded && typeof device.removeEventListener === "function";
    } catch (error) {
      evidence.cleanup.uncapturedListenerRemoveError = messageOf(error);
    }
  }
}

export function encodeSyntheticWgpuCommandRecord(op, payload = []) {
  if (op !== SYNTHETIC_WGPU_COMMAND_OP.CLEAR && op !== SYNTHETIC_WGPU_COMMAND_OP.DRAW_TEST) {
    throw new RangeError(`Unsupported synthetic WGPU opcode: ${op}`);
  }
  if (payload.length > 7) {
    throw new RangeError("Synthetic WGPU command payload exceeds seven words");
  }

  const record = new ArrayBuffer(COMMAND_RECORD_BYTES);
  const view = new DataView(record);
  view.setUint32(0, op, true);
  for (let index = 0; index < payload.length; index += 1) {
    view.setFloat32((index + 1) * 4, Number(payload[index]) || 0, true);
  }
  return new Uint8Array(record);
}

export function decodeSyntheticWgpuCommandRecord(record) {
  const bytes = asCommandBytes(record);
  if (bytes.byteLength !== COMMAND_RECORD_BYTES) {
    throw new RangeError(`Synthetic WGPU command record must be ${COMMAND_RECORD_BYTES} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const op = view.getUint32(0, true);
  const opName = op === SYNTHETIC_WGPU_COMMAND_OP.CLEAR
    ? "CLEAR"
    : op === SYNTHETIC_WGPU_COMMAND_OP.DRAW_TEST
      ? "DRAW_TEST"
      : "UNKNOWN";
  return {
    byteLength: bytes.byteLength,
    op,
    opName,
    payload: Array.from({ length: 7 }, (_, index) => view.getFloat32((index + 1) * 4, true))
  };
}

export async function dispatchSyntheticWgpuCommandRecord(record, handlers) {
  const decoded = decodeSyntheticWgpuCommandRecord(record);
  if (decoded.op === SYNTHETIC_WGPU_COMMAND_OP.CLEAR && typeof handlers?.clear === "function") {
    return { decoded, handler: "clear", result: await handlers.clear(decoded) };
  }
  if (decoded.op === SYNTHETIC_WGPU_COMMAND_OP.DRAW_TEST && typeof handlers?.drawTest === "function") {
    return { decoded, handler: "drawTest", result: await handlers.drawTest(decoded) };
  }
  throw stageError("UNSUPPORTED_SYNTHETIC_COMMAND", "command-ring.decode", `No synthetic handler for opcode ${decoded.op}`);
}

export function compareRgba(actual, expected, { tolerance = 0, mask = null } = {}) {
  if (actual.length !== expected.length || actual.length % 4 !== 0) {
    return {
      pass: false,
      comparedPixels: 0,
      mismatchCount: Math.max(actual.length, expected.length) / 4,
      maxChannelDelta: 255,
      diff: new Uint8ClampedArray(Math.max(actual.length, expected.length))
    };
  }

  const diff = new Uint8ClampedArray(actual.length);
  let comparedPixels = 0;
  let mismatchCount = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < actual.length / 4; pixel += 1) {
    if (mask && !mask[pixel]) continue;
    comparedPixels += 1;
    let mismatch = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const offset = pixel * 4 + channel;
      const delta = Math.abs(actual[offset] - expected[offset]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      mismatch ||= delta > tolerance;
    }
    if (mismatch) {
      mismatchCount += 1;
      diff.set([255, 0, 0, 255], pixel * 4);
    }
  }

  return {
    pass: mismatchCount === 0 && comparedPixels > 0,
    comparedPixels,
    mismatchCount,
    maxChannelDelta,
    diff
  };
}

export function buildWebGpuSyntheticExport(result) {
  const files = [{
    content: `${JSON.stringify(result, null, 2)}\n`,
    mimeType: "application/json",
    name: "evidence.json"
  }];

  for (const test of result?.tests || []) {
    for (const kind of ["actual", "expected", "diff"]) {
      const dataUrl = test.imageArtifacts?.[kind];
      if (!dataUrl) continue;
      files.push({
        dataUrl,
        mimeType: "image/png",
        name: `${safeFileName(test.name)}-${kind}.png`
      });
    }
  }

  return {
    suggestedDirectory: result?.output?.suggestedDirectory || ".omx/wgpu-synthetic/unknown",
    files
  };
}

export function downloadWebGpuSyntheticEvidence(result, { documentRef = globalThis.document } = {}) {
  const bundle = buildWebGpuSyntheticExport(result);
  const downloaded = [];
  for (const file of bundle.files) {
    const link = documentRef?.createElement?.("a");
    if (!link) continue;
    link.download = `${result?.output?.runId || "wgpu-synthetic"}-${file.name}`;
    link.href = file.dataUrl || `data:${file.mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
    documentRef.body?.appendChild?.(link);
    link.click();
    link.remove();
    downloaded.push(link.download);
  }
  return { downloaded, suggestedDirectory: bundle.suggestedDirectory };
}

export function makeSolidExpected(width, height, color) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  return pixels;
}

export function makeCheckerExpected(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tx = Math.min(7, Math.floor((x * 8) / width));
      const ty = Math.min(7, Math.floor((y * 8) / height));
      pixels.set((tx + ty) % 2 === 0 ? SYNTHETIC_COLORS.checkerA : SYNTHETIC_COLORS.checkerB, (y * width + x) * 4);
    }
  }
  return pixels;
}

export function makeTriangleExpected(width, height) {
  const pixels = makeSolidExpected(width, height, SYNTHETIC_COLORS.background);
  const mask = new Uint8Array(width * height);
  const a = [-0.75, -0.75];
  const b = [0.75, -0.75];
  const c = [0, 0.75];
  const edgeGuard = 2 / Math.min(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const point = [((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2];
      const inside = pointInTriangle(point, a, b, c);
      const pixel = y * width + x;
      if (inside) pixels.set(SYNTHETIC_COLORS.triangle, pixel * 4);
      mask[pixel] = distanceFromTriangleEdges(point, a, b, c) > edgeGuard ? 1 : 0;
    }
  }
  return { pixels, mask };
}

async function runSyntheticCommandRing(options) {
  const records = [
    encodeSyntheticWgpuCommandRecord(
      SYNTHETIC_WGPU_COMMAND_OP.CLEAR,
      SYNTHETIC_COLORS.clear.map((value) => value / 255)
    ),
    encodeSyntheticWgpuCommandRecord(SYNTHETIC_WGPU_COMMAND_OP.DRAW_TEST)
  ];
  const results = [];
  const handled = [];

  for (const record of records) {
    const dispatched = await dispatchSyntheticWgpuCommandRecord(record, {
      clear: async () => runOneDiagnostic({ name: "clear", ...options }),
      drawTest: async () => runOneDiagnostic({ name: "static-triangle", ...options })
    });
    results.push(dispatched.result);
    handled.push({
      byteLength: dispatched.decoded.byteLength,
      handler: dispatched.handler,
      op: dispatched.decoded.op,
      opName: dispatched.decoded.opName,
      recordHex: bytesToHex(record),
      resultStatus: dispatched.result.status
    });
  }

  return {
    evidence: {
      status: results.every((result) => result.status === "pass") ? "pass" : "fail",
      recordBytes: COMMAND_RECORD_BYTES,
      source: "synthetic-js-only-complete-records",
      handled,
      realDolphinRingRouting: "pending-phase-6b-atomicity-and-upload-lifetime-gates",
      realDolphinDrawsSent: false
    },
    results
  };
}

async function runOneDiagnostic(options) {
  try {
    if (options.name === "clear") return await runClear(options);
    if (options.name === "static-triangle") return await runTriangle(options);
    return await runChecker(options);
  } catch (error) {
    return {
      ...(error?.partial || {}),
      name: options.name,
      status: "fail",
      code: error?.code || "UNEXPECTED_DIAGNOSTIC_ERROR",
      stage: error?.stage || options.name,
      error: messageOf(error)
    };
  }
}

async function runClear(options) {
  const expected = makeSolidExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE, SYNTHETIC_COLORS.clear);
  const result = await runRenderAndValidate(options, {
    expected,
    tolerance: 1,
    encode({ encoder, view }) {
      const pass = encoder.beginRenderPass({
        label: "wgpu-synthetic-clear-pass",
        colorAttachments: [{
          view,
          clearValue: normalizedColor(SYNTHETIC_COLORS.clear),
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.end();
    }
  });
  delete result.actual;
  return result;
}

async function runTriangle(options) {
  const { device, format } = options;
  const shader = createShaderModule(device, {
    label: "wgpu-synthetic-static-triangle",
    code: `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.75, -0.75),
    vec2<f32>(0.75, -0.75),
    vec2<f32>(0.0, 0.75)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(${normalizedLiteral(SYNTHETIC_COLORS.triangle)});
}`
  }, "static-triangle.shader");
  const shaderEvidence = await shaderCompilationEvidence(shader);
  if (shaderEvidence.errors.length > 0) throw stageError("SHADER_COMPILE_FAILED", "static-triangle.shader", shaderEvidence.errors[0].message);
  const pipeline = await createPipeline(device, {
    label: "wgpu-synthetic-static-triangle",
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  }, "static-triangle.pipeline");
  const expected = makeTriangleExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  const result = await runRenderAndValidate(options, {
    expected: expected.pixels,
    mask: expected.mask,
    tolerance: 1,
    encode({ encoder, view }) {
      const pass = encoder.beginRenderPass({
        label: "wgpu-synthetic-static-triangle-pass",
        colorAttachments: [{
          view,
          clearValue: normalizedColor(SYNTHETIC_COLORS.background),
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
    }
  });
  result.shader = shaderEvidence;
  result.samples = validateTriangleSamples(result.actual, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  if (!result.samples.every((sample) => sample.pass)) {
    result.status = "fail";
    result.code = "TRIANGLE_SAMPLE_MISMATCH";
    result.stage = "static-triangle.expected-output";
  }
  delete result.actual;
  return result;
}

async function runChecker(options) {
  const { device, format, constants } = options;
  const textureBytes = checkerTextureBytes();
  let texture = null;
  let textureResource = {
    created: false,
    destroyed: false,
    kind: "checker-texture"
  };
  let bindGroupResource = {
    created: false,
    kind: "checker-bind-group"
  };
  let result = null;

  try {
    const textureCreation = await createScopedGpuResource(device, {
      code: "TEXTURE_CREATE_FAILED",
      kind: "checker-texture",
      stage: "checker.texture",
      create: () => device.createTexture({
        label: "wgpu-synthetic-checker-upload",
        size: { width: 8, height: 8 },
        format: "rgba8unorm",
        usage: constants.GPUTextureUsage.TEXTURE_BINDING | constants.GPUTextureUsage.COPY_DST
      })
    });
    texture = textureCreation.resource;
    textureResource = textureCreation.evidence;
    const upload = await uploadCheckerTexture(device, texture, textureBytes, options.now);

    const shader = createShaderModule(device, {
      label: "wgpu-synthetic-checker-blit",
      code: `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var checker_texture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(checker_texture);
  let x = min(i32(position.x) * i32(dimensions.x) / ${DIAGNOSTIC_SIZE}, i32(dimensions.x) - 1);
  let y = min(i32(position.y) * i32(dimensions.y) / ${DIAGNOSTIC_SIZE}, i32(dimensions.y) - 1);
  return textureLoad(checker_texture, vec2<i32>(x, y), 0);
}`
    }, "checker.shader");
    const shaderEvidence = await shaderCompilationEvidence(shader);
    if (shaderEvidence.errors.length > 0) throw stageError("SHADER_COMPILE_FAILED", "checker.shader", shaderEvidence.errors[0].message);
    const pipeline = await createPipeline(device, {
      label: "wgpu-synthetic-checker-blit",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    }, "checker.pipeline");
    const bindGroupCreation = await createScopedGpuResource(device, {
      code: "BIND_GROUP_CREATE_FAILED",
      kind: "checker-bind-group",
      stage: "checker.bind-group",
      create: () => device.createBindGroup({
        label: "wgpu-synthetic-checker-bind-group",
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }]
      })
    });
    const bindGroup = bindGroupCreation.resource;
    bindGroupResource = bindGroupCreation.evidence;

    result = await runRenderAndValidate(options, {
      expected: makeCheckerExpected(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE),
      tolerance: 1,
      encode({ encoder, view }) {
        const pass = encoder.beginRenderPass({
          label: "wgpu-synthetic-checker-pass",
          colorAttachments: [{
            view,
            clearValue: normalizedColor(SYNTHETIC_COLORS.background),
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      }
    });
    result.upload = upload;
    result.shader = shaderEvidence;
    result.samples = validateCheckerSamples(result.actual, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
    if (!result.samples.every((sample) => sample.pass)) {
      result.status = "fail";
      result.code = "CHECKER_TEXEL_MISMATCH";
      result.stage = "checker.expected-output";
    }
    delete result.actual;
    result.resources = {
      ...result.resources,
      bindGroup: bindGroupResource,
      checkerTexture: textureResource
    };
    return result;
  } catch (error) {
    error.partial = mergePartialEvidence(error.partial, {
      resources: {
        bindGroup: error.partial?.resources?.bindGroup || bindGroupResource,
        checkerTexture: error.partial?.resources?.checkerTexture || textureResource
      }
    });
    throw error;
  } finally {
    if (texture) {
      try {
        texture.destroy();
        textureResource.destroyed = true;
      } catch (error) {
        textureResource.destroyError = messageOf(error);
        if (result) {
          result.status = "fail";
          result.code = "RESOURCE_CLEANUP_FAILED";
          result.stage = "checker.texture.destroy";
          result.error = textureResource.destroyError;
        }
      }
    }
  }
}

async function runRenderAndValidate(options, { expected, mask = null, tolerance, encode }) {
  const { name, device, context, format, constants, documentRef, now } = options;
  let scopeOpen = false;
  let readback = null;
  let readbackMapped = false;
  let result = null;
  let caught = null;
  const submit = { submitted: false, completed: false };
  const errorScope = {
    type: "validation",
    pushed: false,
    popped: false,
    error: null
  };
  const resources = {
    readback: {
      created: false,
      destroyed: false
    }
  };

  try {
    device.pushErrorScope("validation");
    scopeOpen = true;
    errorScope.pushed = true;
    const texture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder({ label: `wgpu-synthetic-${name}` });
    encode({ encoder, view: texture.createView() });

    const bytesPerRow = align(DIAGNOSTIC_SIZE * 4, 256);
    readback = device.createBuffer({
      label: `wgpu-synthetic-${name}-readback`,
      size: bytesPerRow * DIAGNOSTIC_SIZE,
      usage: constants.GPUBufferUsage.COPY_DST | constants.GPUBufferUsage.MAP_READ
    });
    resources.readback.created = true;
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow, rowsPerImage: DIAGNOSTIC_SIZE },
      { width: DIAGNOSTIC_SIZE, height: DIAGNOSTIC_SIZE }
    );

    const submittedAt = now();
    submit.attemptedAtMs = roundMs(submittedAt);
    try {
      device.queue.submit([encoder.finish()]);
      submit.submitted = true;
      submit.submittedAtMs = roundMs(submittedAt);
    } catch (error) {
      throw stageError("SUBMIT_FAILED", `${name}.submit`, messageOf(error));
    }
    try {
      await device.queue.onSubmittedWorkDone();
      submit.completed = true;
      submit.completionMs = roundMs(now() - submittedAt);
    } catch (error) {
      throw stageError("COMPLETION_FAILED", `${name}.completion`, messageOf(error));
    }

    let scopedError;
    try {
      scopedError = await device.popErrorScope();
      scopeOpen = false;
      errorScope.popped = true;
    } catch (error) {
      throw stageError("ERROR_SCOPE_FAILED", `${name}.error-scope`, messageOf(error));
    }
    if (scopedError) {
      errorScope.error = serializeGpuError(scopedError);
      throw stageError("VALIDATION_ERROR", `${name}.validation`, errorScope.error.message);
    }

    try {
      await readback.mapAsync(constants.GPUMapMode.READ);
      readbackMapped = true;
    } catch (error) {
      throw stageError("READBACK_FAILED", `${name}.readback`, messageOf(error));
    }
    const actual = unpackReadback(new Uint8Array(readback.getMappedRange()), DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE, bytesPerRow, format);
    readback.unmap();
    readbackMapped = false;

    const validation = compareRgba(actual, expected, { tolerance, mask });
    result = {
      name,
      status: validation.pass ? "pass" : "fail",
      code: validation.pass ? "PASS" : "EXPECTED_OUTPUT_MISMATCH",
      stage: validation.pass ? `${name}.complete` : `${name}.expected-output`,
      submit,
      validation: withoutDiff(validation),
      imageArtifacts: imageArtifacts(documentRef, actual, expected, validation.diff, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE),
      actual
    };
  } catch (error) {
    caught = error?.code
      ? error
      : stageError("UNEXPECTED_RENDER_ERROR", `${name}.render`, messageOf(error));
  } finally {
    if (scopeOpen) {
      try {
        const scopedError = await device.popErrorScope();
        errorScope.popped = true;
        if (scopedError) errorScope.error = serializeGpuError(scopedError);
      } catch (error) {
        errorScope.popError = messageOf(error);
        caught ||= stageError("ERROR_SCOPE_FAILED", `${name}.error-scope`, messageOf(error));
      }
    }
    if (readbackMapped) {
      try {
        readback.unmap();
      } catch (error) {
        resources.readback.unmapError = messageOf(error);
      }
    }
    if (readback) {
      try {
        readback.destroy();
        resources.readback.destroyed = true;
      } catch (error) {
        resources.readback.destroyError = messageOf(error);
        caught ||= stageError("RESOURCE_CLEANUP_FAILED", `${name}.readback.destroy`, messageOf(error));
      }
    }
  }

  if (caught) {
    caught.partial = mergePartialEvidence(caught.partial, {
      errorScope: { ...errorScope },
      resources,
      submit: { ...submit }
    });
    throw caught;
  }

  result.errorScope = { ...errorScope };
  result.resources = resources;
  return result;
}

async function createScopedGpuResource(device, { code, kind, stage, create }) {
  const evidence = {
    kind,
    created: false,
    errorScope: {
      type: "validation",
      pushed: false,
      popped: false,
      error: null
    }
  };
  let scopeOpen = false;
  let resource = null;
  let caught = null;

  try {
    device.pushErrorScope("validation");
    scopeOpen = true;
    evidence.errorScope.pushed = true;
    resource = create();
    evidence.created = true;
  } catch (error) {
    caught = stageError(code, stage, messageOf(error));
  } finally {
    if (scopeOpen) {
      try {
        const scopedError = await device.popErrorScope();
        evidence.errorScope.popped = true;
        if (scopedError) {
          evidence.errorScope.error = serializeGpuError(scopedError);
          caught ||= stageError(code, stage, evidence.errorScope.error.message);
        }
      } catch (error) {
        evidence.errorScope.popError = messageOf(error);
        caught ||= stageError("ERROR_SCOPE_FAILED", `${stage}.error-scope`, messageOf(error));
      }
    }
  }

  if (caught) {
    if (resource?.destroy) {
      try {
        resource.destroy();
        evidence.destroyed = true;
      } catch (error) {
        evidence.destroyError = messageOf(error);
      }
    }
    caught.partial = mergePartialEvidence(caught.partial, {
      errorScope: { ...evidence.errorScope },
      resources: { [resourceEvidenceKey(kind)]: evidence }
    });
    throw caught;
  }

  return { evidence, resource };
}

async function createPipeline(device, descriptor, stage) {
  try {
    return typeof device.createRenderPipelineAsync === "function"
      ? await device.createRenderPipelineAsync(descriptor)
      : device.createRenderPipeline(descriptor);
  } catch (error) {
    throw stageError("PIPELINE_CREATE_FAILED", stage, messageOf(error));
  }
}

function createShaderModule(device, descriptor, stage) {
  try {
    return device.createShaderModule(descriptor);
  } catch (error) {
    throw stageError("SHADER_CREATE_FAILED", stage, messageOf(error));
  }
}

async function uploadCheckerTexture(device, texture, bytes, now) {
  let scopeOpen = false;
  const startedAt = now();
  const evidence = {
    bytes: bytes.byteLength,
    completed: false,
    errorScope: {
      type: "validation",
      pushed: false,
      popped: false,
      error: null
    }
  };
  try {
    device.pushErrorScope("validation");
    scopeOpen = true;
    evidence.errorScope.pushed = true;
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: 32, rowsPerImage: 8 },
      { width: 8, height: 8 }
    );
    await device.queue.onSubmittedWorkDone();
    const scopedError = await device.popErrorScope();
    scopeOpen = false;
    evidence.errorScope.popped = true;
    if (scopedError) {
      evidence.errorScope.error = serializeGpuError(scopedError);
      throw stageError("TEXTURE_UPLOAD_VALIDATION_ERROR", "checker.upload", evidence.errorScope.error.message);
    }
    evidence.completed = true;
    evidence.completionMs = roundMs(now() - startedAt);
    return evidence;
  } catch (error) {
    const failure = error?.code
      ? error
      : stageError("TEXTURE_UPLOAD_FAILED", "checker.upload", messageOf(error));
    failure.partial = mergePartialEvidence(failure.partial, { upload: evidence });
    throw failure;
  } finally {
    if (scopeOpen) {
      try {
        const scopedError = await device.popErrorScope();
        evidence.errorScope.popped = true;
        if (scopedError) evidence.errorScope.error = serializeGpuError(scopedError);
      } catch (error) {
        evidence.errorScope.popError = messageOf(error);
      }
    }
  }
}

async function shaderCompilationEvidence(shader) {
  if (typeof shader.getCompilationInfo !== "function") return { messages: [], errors: [] };
  const info = await shader.getCompilationInfo();
  const messages = [...(info?.messages || [])].map((message) => ({
    type: String(message.type || "info"),
    message: String(message.message || ""),
    lineNum: Number(message.lineNum || 0),
    linePos: Number(message.linePos || 0)
  }));
  return { messages, errors: messages.filter((message) => message.type === "error") };
}

function validateTriangleSamples(actual, width, height) {
  return [
    sample(actual, width, 32, 24, SYNTHETIC_COLORS.triangle, "inside-upper"),
    sample(actual, width, 32, 43, SYNTHETIC_COLORS.triangle, "inside-lower"),
    sample(actual, width, 4, 4, SYNTHETIC_COLORS.background, "outside-top-left"),
    sample(actual, width, 59, 32, SYNTHETIC_COLORS.background, "outside-right"),
    sample(actual, width, 32, height - 3, SYNTHETIC_COLORS.background, "outside-bottom")
  ];
}

function validateCheckerSamples(actual, width, height) {
  return [
    sample(actual, width, 4, 4, SYNTHETIC_COLORS.checkerA, "texel-0-0"),
    sample(actual, width, 12, 4, SYNTHETIC_COLORS.checkerB, "texel-1-0"),
    sample(actual, width, 4, 12, SYNTHETIC_COLORS.checkerB, "texel-0-1"),
    sample(actual, width, width - 4, height - 4, SYNTHETIC_COLORS.checkerA, "texel-7-7")
  ];
}

function sample(actual, width, x, y, expected, label) {
  const rgba = [...actual.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  const maxChannelDelta = Math.max(...rgba.map((value, index) => Math.abs(value - expected[index])));
  return { label, x, y, rgba, expected: [...expected], maxChannelDelta, pass: maxChannelDelta <= 1 };
}

function checkerTextureBytes() {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bytes.set((x + y) % 2 === 0 ? SYNTHETIC_COLORS.checkerA : SYNTHETIC_COLORS.checkerB, (y * 8 + x) * 4);
  }
  return bytes;
}

function unpackReadback(bytes, width, height, bytesPerRow, format) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * bytesPerRow + x * 4;
      const target = (y * width + x) * 4;
      if (format === "bgra8unorm") {
        pixels.set([bytes[source + 2], bytes[source + 1], bytes[source], bytes[source + 3]], target);
      } else {
        pixels.set(bytes.subarray(source, source + 4), target);
      }
    }
  }
  return pixels;
}

function imageArtifacts(documentRef, actual, expected, diff, width, height) {
  return {
    actual: pixelsToDataUrl(documentRef, actual, width, height),
    expected: pixelsToDataUrl(documentRef, expected, width, height),
    diff: pixelsToDataUrl(documentRef, diff, width, height)
  };
}

function pixelsToDataUrl(documentRef, pixels, width, height) {
  const canvas = documentRef?.createElement?.("canvas");
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function appendEvidenceSummary(documentRef, result) {
  const panel = documentRef?.querySelector?.(".control-panel");
  if (!panel || documentRef.querySelector("#wgpuSyntheticEvidence")) return;
  const pre = documentRef.createElement("pre");
  pre.id = "wgpuSyntheticEvidence";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontSize = "11px";
  pre.textContent = JSON.stringify({
    schema: result.schema,
    schemaRevision: result.schemaRevision,
    status: result.status,
    startedAtUtc: result.startedAtUtc,
    finishedAtUtc: result.finishedAtUtc,
    attribution: result.attribution,
    output: result.output,
    classifier: result.classifier,
    route: result.route,
    commandRing: result.commandRing,
    tests: result.tests.map(({ name, status, code, stage, errorScope, resources, submit, upload, validation, samples }) => ({
      name,
      status,
      code,
      stage,
      errorScope,
      resources,
      submit,
      upload,
      validation,
      samples,
      imageArtifacts: Object.fromEntries(
        Object.entries(result.tests.find((candidate) => candidate.name === name)?.imageArtifacts || {})
          .map(([kind, value]) => [kind, value ? `${name}-${kind}.png` : null])
      )
    })),
    uncapturedErrors: result.uncapturedErrors,
    deviceLoss: result.deviceLoss,
    cleanup: result.cleanup,
    markers: result.markers
  }, null, 2);
  panel.append(pre);
}

function fail(evidence, mark, code, stage, error, startedAt, now, wallNow = () => Date.now()) {
  evidence.status = "fail";
  evidence.elapsedMs = roundMs(now() - startedAt);
  evidence.finishedAtUtc = new Date(wallNow()).toISOString();
  updateOutputManifest(evidence);
  evidence.classifier = {
    status: "fail",
    code,
    stage,
    error: String(error || ""),
    marker: `WGPU_SYNTHETIC_CLASSIFIER:FAIL:${code}:${stage}`
  };
  mark(evidence.classifier.marker);
  return evidence;
}

function updateOutputManifest(evidence) {
  evidence.output.imageFiles = (evidence.tests || []).flatMap((test) =>
    ["actual", "expected", "diff"]
      .filter((kind) => Boolean(test.imageArtifacts?.[kind]))
      .map((kind) => `${evidence.output.suggestedDirectory}/${safeFileName(test.name)}-${kind}.png`)
  );
}

function stageError(code, stage, message) {
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  return error;
}

function mergePartialEvidence(current = {}, next = {}) {
  return {
    ...current,
    ...next,
    resources: {
      ...(current.resources || {}),
      ...(next.resources || {})
    }
  };
}

function resourceEvidenceKey(kind) {
  if (kind === "checker-texture") return "checkerTexture";
  if (kind === "checker-bind-group") return "bindGroup";
  return String(kind || "resource").replaceAll("-", "_");
}

function asCommandBytes(record) {
  if (record instanceof Uint8Array) return record;
  if (record instanceof ArrayBuffer) return new Uint8Array(record);
  if (ArrayBuffer.isView(record)) {
    return new Uint8Array(record.buffer, record.byteOffset, record.byteLength);
  }
  throw new TypeError("Synthetic WGPU command record must be an ArrayBuffer or view");
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function parseDirty(value) {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function chromeVersion(userAgent) {
  return /(?:Chrome|Chromium)\/([^\s]+)/.exec(String(userAgent || ""))?.[1] || "unknown";
}

function safeFileName(value) {
  return String(value || "diagnostic").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "diagnostic";
}

async function adapterInfo(adapter) {
  try {
    const info = adapter.info || (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : null);
    if (!info) return {};
    return Object.fromEntries(["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize"].filter((key) => info[key] !== undefined).map((key) => [key, info[key]]));
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function supportedLimits(limits) {
  return Object.fromEntries(LIMIT_NAMES.filter((name) => Number.isFinite(Number(limits?.[name]))).map((name) => [name, Number(limits[name])]));
}

function sortedFeatures(features) {
  try {
    return [...(features || [])].map(String).sort();
  } catch {
    return [];
  }
}

function serializeGpuError(error) {
  return {
    name: String(error?.constructor?.name || error?.name || "GPUError"),
    message: messageOf(error)
  };
}

function pointInTriangle(point, a, b, c) {
  const d1 = signedArea(point, a, b);
  const d2 = signedArea(point, b, c);
  const d3 = signedArea(point, c, a);
  return !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0);
}

function distanceFromTriangleEdges(point, a, b, c) {
  return Math.min(distanceFromLine(point, a, b), distanceFromLine(point, b, c), distanceFromLine(point, c, a));
}

function signedArea(point, a, b) {
  return (point[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (point[1] - b[1]);
}

function distanceFromLine(point, a, b) {
  return Math.abs((b[1] - a[1]) * point[0] - (b[0] - a[0]) * point[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(b[1] - a[1], b[0] - a[0]);
}

function normalizedColor(color) {
  return { r: color[0] / 255, g: color[1] / 255, b: color[2] / 255, a: color[3] / 255 };
}

function normalizedLiteral(color) {
  return color.map((value) => (value / 255).toFixed(9)).join(", ");
}

function withoutDiff(validation) {
  const { diff: _diff, ...summary } = validation;
  return summary;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function messageOf(error) {
  return String(error?.message || error || "unknown error");
}
