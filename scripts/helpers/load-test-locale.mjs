/**
 * 前端入口会先加载语言包再运行可能产生本地化错误的代码。
 * 直接调用服务 / 适配器的测试也必须模拟这一步，避免把测试引导错误当成产品故障。
 */
import { loadLocale } from '../../src/locales/index.ts'

await loadLocale('zh-Hans')
