/** 把各语言的多行 DOS 启动前命令规范化；非法配置节与控制字符会抛错。 */
export function normalizeDosStartupCommands(value: unknown): string
