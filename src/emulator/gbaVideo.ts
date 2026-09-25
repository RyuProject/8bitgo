/**
 * GBA 画质策略。
 *
 * GBA 核心交出来的已经是 240×160 的最终像素帧，并不存在像 3D 主机那样把“内部渲染
 * 分辨率”调高一档的空间。真正需要修的是两件事：
 *
 * 1. RetroArch 默认允许把 240×160 铺成任意尺寸。最近邻虽然不会糊，但非整数倍率会让
 *    一部分源像素占 5 个物理像素、另一部分占 6 个，移动时就像细线在抖。因此 GBA 单独
 *    开整数缩放；剩下的空间留黑边，由播放器背景承接。
 * 2. 想要更圆润或更像掌机屏幕时，用 GPU 后处理，绝不能全局打开双线性 / FXAA ——
 *    那会把字体、血条和像素画一起抹糊。
 *
 * 三档都只影响画面，不碰核心、存档或模拟速度；选择按游戏存在站内自己的 key 里，避免
 * EmulatorJS 的通用 shader 设置串到别的平台。
 */

export type GbaVideoMode = 'pixel' | 'smooth' | 'lcd'

export const GBA_DEFAULT_VIDEO_MODE: GbaVideoMode = 'pixel'
export const GBA_LCD_SHADER_NAME = '8bitgo-gba-lcd.glslp'

const SHADER_BY_MODE: Record<GbaVideoMode, string> = {
  pixel: 'disabled',
  smooth: '2xScaleHQ.glslp',
  lcd: GBA_LCD_SHADER_NAME,
}

export function gbaShaderForMode(mode: GbaVideoMode): string {
  return SHADER_BY_MODE[mode]
}

export function isGbaVideoMode(value: unknown): value is GbaVideoMode {
  return value === 'pixel' || value === 'smooth' || value === 'lcd'
}

/** 游戏名只作 localStorage 坐标，不进 URL；encode 避免分隔符造成两个游戏撞 key。 */
export function gbaVideoStorageKey(game: string): string {
  return `8bitgo:gba-video:${encodeURIComponent(game.trim() || 'default')}`
}

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

export function readGbaVideoMode(storage: StorageReader | null | undefined, game: string): GbaVideoMode {
  try {
    const value = storage?.getItem(gbaVideoStorageKey(game))
    return isGbaVideoMode(value) ? value : GBA_DEFAULT_VIDEO_MODE
  } catch {
    // Safari 无痕 / 隐私模式可能直接拒绝 localStorage；画质偏好不能拦开局。
    return GBA_DEFAULT_VIDEO_MODE
  }
}

export function writeGbaVideoMode(storage: StorageWriter | null | undefined, game: string, mode: GbaVideoMode): void {
  try {
    storage?.setItem(gbaVideoStorageKey(game), mode)
  } catch {
    // 同上：这一局已经切换成功，只是下次不记忆。
  }
}

/**
 * 幂等写入 RetroArch 配置。重复键不能全留下：不同 RetroArch 版本对“第一条还是最后一条
 * 生效”处理并不一致，保留两条会把一个确定的修复重新变成版本碰运气。
 */
function setCfgValue(config: string, key: string, value: string): string {
  const newline = config.endsWith('\n') ? '\n' : ''
  const lines = config.split(/\r?\n/)
  let found = false
  const next: string[] = []
  for (const line of lines) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      if (!found) next.push(`${key} = ${value}`)
      found = true
      continue
    }
    // split 会把末尾换行变成一个空项，最后统一补回，避免越跑空行越多。
    if (line || next.length < lines.length - 1) next.push(line)
  }
  if (!found) next.push(`${key} = ${value}`)
  return next.join('\n').replace(/\n+$/, '') + newline
}

export function configureGbaVideo(config: string): string {
  let next = setCfgValue(config, 'video_smooth', 'false')
  next = setCfgValue(next, 'video_scale_integer', 'true')
  return next
}

/**
 * 一次采样的轻量 LCD shader：只做很淡的源像素栅格和 GBA 屏幕色调校正。
 * 不做曲面、拖影、噪点和多 pass 模糊，所以移动 GPU 的负担远低于 CRT shader，
 * 也不会让《宝可梦》这类小字号菜单变糊。
 */
const GBA_LCD_GLSL = `
#if defined(VERTEX)

#if __VERSION__ >= 130
#define COMPAT_VARYING out
#define COMPAT_ATTRIBUTE in
#else
#define COMPAT_VARYING varying
#define COMPAT_ATTRIBUTE attribute
#endif

#ifdef GL_ES
#define COMPAT_PRECISION mediump
#else
#define COMPAT_PRECISION
#endif

COMPAT_ATTRIBUTE vec4 VertexCoord;
COMPAT_ATTRIBUTE vec4 COLOR;
COMPAT_ATTRIBUTE vec4 TexCoord;
COMPAT_VARYING vec4 TEX0;
uniform mat4 MVPMatrix;

void main() {
  gl_Position = MVPMatrix * VertexCoord;
  TEX0.xy = TexCoord.xy;
}

#elif defined(FRAGMENT)

#ifdef GL_ES
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define COMPAT_PRECISION mediump
#else
#define COMPAT_PRECISION
#endif

#if __VERSION__ >= 130
#define COMPAT_VARYING in
#define COMPAT_TEXTURE texture
out COMPAT_PRECISION vec4 FragColor;
#else
#define COMPAT_VARYING varying
#define COMPAT_TEXTURE texture2D
#define FragColor gl_FragColor
#endif

uniform COMPAT_PRECISION vec2 TextureSize;
uniform sampler2D Texture;
COMPAT_VARYING vec4 TEX0;

void main() {
  vec4 source = COMPAT_TEXTURE(Texture, TEX0.xy);
  vec3 color = source.rgb;

  // 很轻的暖绿 LCD 色调；幅度刻意压低，白底与小字仍保持准确。
  color = pow(color, vec3(0.94));
  color = vec3(
    dot(color, vec3(0.965, 0.030, 0.005)),
    dot(color, vec3(0.015, 0.975, 0.010)),
    dot(color, vec3(0.010, 0.045, 0.945))
  );

  // TEX0 的有效范围按 TextureSize 映回源像素；只压暗像素边缘，不采邻居，所以不糊字。
  vec2 cell = fract(TEX0.xy * TextureSize);
  vec2 inside = smoothstep(vec2(0.02), vec2(0.11), cell) *
                smoothstep(vec2(0.02), vec2(0.11), 1.0 - cell);
  float grid = mix(0.91, 1.0, inside.x * inside.y);
  color *= grid;

  // 3% 的 RGB 子像素纹理，只给出掌机屏幕质感，避免彩边盖过原作像素。
  float column = mod(floor(gl_FragCoord.x), 3.0);
  vec3 mask = column < 1.0 ? vec3(1.0, 0.96, 0.96) :
              (column < 2.0 ? vec3(0.96, 1.0, 0.96) : vec3(0.96, 0.96, 1.0));
  color *= mask;

  FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
}
#endif
`

export const GBA_ADDITIONAL_SHADERS = {
  [GBA_LCD_SHADER_NAME]: {
    shader: {
      type: 'text',
      value: `shaders = 1\n\nshader0 = "8bitgo-gba-lcd.glsl"\nfilter_linear0 = false\nscale_type_0 = source\n`,
    },
    resources: [{ name: '8bitgo-gba-lcd.glsl', type: 'text', value: GBA_LCD_GLSL }],
  },
} as const
