/**
 * 「玩家提交游戏」前后端共用的常量。
 *
 * 前端要用它来在**选文件的当下**就拦住超大 / 不能收的文件，服务端要用同一份来
 * 真正说了算。两边各写一份的下场是老三样：界面上放行、传完二十兆再被拒，
 * 或者反过来 —— 界面拦着不让传，其实服务端收得下。
 *
 * 本体必须是 .js：server/ 不过 TypeScript 编译。类型声明在同名 .d.ts 里手写，
 * 改了这里的导出记得同步那边。
 */

/** ROM 支持的语言。字段名 rom_<key>，故意不带连字符，免得出现在 multipart 字段名里 */
export const SUBMIT_ROM_LANGS = ['en', 'ja', 'zh', 'zhHant', 'de', 'fr', 'it', 'es']

/** 发给站长的那封信里用的语言名（站长看的，固定中文，不跟着访客语言走） */
export const SUBMIT_ROM_LANG_LABEL_ZH = {
  en: '英语',
  ja: '日语',
  zh: '中文',
  zhHant: '繁体中文',
  de: '德语',
  fr: '法语',
  it: '意大利语',
  es: '西班牙语',
}

/**
 * 允许当邮件附件发的扩展名。
 *
 * 这不是洁癖，是「这封信能不能送到」的问题：Gmail / Outlook / 企业邮拒的是
 * **整封信**，不是单个附件 —— 里面夹一个 .exe，八个 ROM 一起被退，提交人还看不到原因。
 * DOS 游戏的 .exe / .com 请打包成 zip 再传，这正是这条规则存在的理由。
 */
export const ALLOWED_ROM_EXT = [
  'zip', '7z', 'rar', 'gz', 'tar',
  'nes', 'unf', 'unif', 'fds', 'nsf',
  'sfc', 'smc', 'fig', 'swc',
  'gb', 'gbc', 'gba', 'nds', 'srl',
  'n64', 'z64', 'v64',
  'md', 'gen', 'smd', 'bin', 'sms', 'gg', 'sg', '32x',
  'pce', 'sgx', 'ngp', 'ngc', 'ws', 'wsc', 'vb', 'lnx',
  'a26', 'a78', 'col', 'vec', 'int',
  'cue', 'iso', 'img', 'chd', 'pbp', 'ccd', 'mdf', 'm3u',
  'd64', 'dsk', 'adf', 'tap', 'st', 'ipf',
  'swf', 'jar', 'jad',
]

/**
 * 默认大小上限（MB），服务端可用 SUBMIT_ROM_MAX_FILE_MB / SUBMIT_ROM_MAX_TOTAL_MB 覆盖。
 *
 * 为什么是 20 而不是 25：常见邮箱的收件上限在 25MB 附近，而附件在信里是 base64 编码的，
 * 体积要再胀三分之一。按 25 设的话，一封都发不出去。
 */
export const DEFAULT_SUBMIT_MAX_FILE_MB = 20
export const DEFAULT_SUBMIT_MAX_TOTAL_MB = 20

/** 取扩展名（小写、不含点）。取不到返回空串 */
export function romExtOf(filename) {
  return String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,6})$/)?.[1] ?? ''
}

/** 这个文件名的扩展名在白名单里吗 */
export function isAllowedRomExt(filename) {
  return ALLOWED_ROM_EXT.includes(romExtOf(filename))
}
