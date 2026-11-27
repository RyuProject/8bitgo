/** js-dos 的别名查询 / 注册 / 对端握手由远端事件完成；弱网或信令中断时必须有界结束。 */
export class IpxOperationTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpxOperationTimeout'
  }
}

export function withIpxTimeout<T>(operation: Promise<T>, message: string, timeoutMs = 20_000): Promise<T> {
  let timer = 0
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new IpxOperationTimeout(message)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => window.clearTimeout(timer))
}
