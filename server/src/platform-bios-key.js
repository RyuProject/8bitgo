/**
 * 平台 BIOS 绑定的 key 校验。
 *
 * BIOS 系统包沿用 `bios:<系统名>` 命名空间。系统名除了街机常见的
 * `neogeo` / `pgm`，还包括 PS1 区域项 `psx-jp` / `psx-us` / `psx-eu`；
 * 连字符因此是协议的一部分，不能只允许下划线，否则后台界面能展示却无法上传。
 */
const VALID_PLATFORM = /^[A-Za-z0-9_-]{1,20}$/
const VALID_BIOS_SET = /^bios:[a-z0-9][a-z0-9_-]{0,31}$/

export function isValidPlatformBiosKey(value) {
  return VALID_PLATFORM.test(value) || VALID_BIOS_SET.test(value)
}
