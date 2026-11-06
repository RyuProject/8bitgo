export interface FlashBridgeSessionTarget {
  callExternalInterface?: (name: string, ...args: unknown[]) => unknown
}

export function settleAgi2BridgeLogin(target: FlashBridgeSessionTarget | null): boolean

export function updateAgi2BridgeSession(
  target: FlashBridgeSessionTarget | null,
  parameters: Record<string, string> | null | undefined,
): boolean
