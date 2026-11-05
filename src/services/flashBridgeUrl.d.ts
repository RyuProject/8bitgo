export function flashSaveBridgeRewriteRules(
  bridgeUrl: string,
  rewriteFrom: readonly string[],
  parameters: Record<string, string>,
): Array<[string, string]>

export function flashSaveBridgeParameters(parameters: Record<string, string>): Record<string, string>
