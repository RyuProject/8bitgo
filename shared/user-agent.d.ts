/** user-agent.js 的类型声明。改了导出记得同步这里。 */
export interface UserAgentClass {
  browser: string
  os: string
  device: 'desktop' | 'mobile' | 'tablet'
}
export declare function classifyUserAgent(ua?: string): UserAgentClass
export declare function browserFamily(browser?: string): string
export declare function osFamily(os?: string): string
