/**
 * 允许后台配置外部镜像的 Windows / DOS 系统盘清单。
 *
 * 只收录本站已经确认存在于 R2、并且同源代理白名单也认可的对象；外部镜像只能替代同名对象，
 * 不能把「能启动的另一份 Windows」误当成备份。前后端共用这份清单，避免后台能保存、播放器却不认。
 */
export const DOS_SYSTEM_IMAGE_CATALOG = Object.freeze([
  Object.freeze({ file: 'system-dos7.1-v1.jsdos', label: 'DOS 7.1 启动盘' }),
  Object.freeze({ file: 'system-win311-v1.jsdos', label: 'Windows 3.1' }),
  Object.freeze({ file: 'system-win95-v1.jsdos', label: 'Windows 95' }),
  Object.freeze({ file: 'system-win98-v1.jsdos', label: 'Windows 98' }),
  Object.freeze({ file: 'Windows95_Traditional-Chinese.jsdos', label: '繁体中文 Windows 95（大富翁4）' }),
  Object.freeze({ file: 'Windows95_Traditional-Chinese-DirectInput-v1.jsdos', label: '繁体中文 Windows 95（DirectInput）' }),
  Object.freeze({ file: 'Windows95_Traditional-Chinese-DirectX7a-Minimal-v1.jsdos', label: '繁体中文 Windows 95（DirectX 7a）' }),
  Object.freeze({ file: 'Windows95_Traditional-Chinese-DirectX7a-UltraLite-v2.jsdos', label: '繁体中文 Windows 95（UltraLite）' }),
])

/** 第一次启用镜像池时预填的用户副本；完整校验通过前，播放器不会请求它。 */
export const DEFAULT_DOS_SYSTEM_IMAGE_SOURCES = Object.freeze({
  version: 1,
  files: Object.freeze({
    'Windows95_Traditional-Chinese.jsdos': Object.freeze({
      sha256: '',
      r2Version: '',
      mirrors: Object.freeze([
        Object.freeze({
          id: 'gitee-traditional-win95',
          label: 'Gitee 繁中 Win95',
          url: 'https://gitee.com/ryuproject/resource-repository/raw/master/system/Windows95_Traditional-Chinese.jsdos',
          enabled: true,
          verifiedSha256: '',
        }),
      ]),
    }),
  }),
})

/**
 * 外部副本数量有硬上限：后台配置是公开可读的，任意增加测速目标会变成玩家侧的并发放大器。
 * 管理员可以维护多个可控镜像，但一次开局最多只会探测四份外部副本。
 */
export const DOS_SYSTEM_IMAGE_MAX_MIRRORS = 4
