export declare const CHAT_MAX_LENGTH: number
export declare const CHAT_HISTORY_SIZE: number
export declare const CHAT_MIN_INTERVAL_MS: number
export declare const CHAT_BURST: number
export declare function sanitizeChatText(raw: unknown): string
export declare function chatTextLength(raw: unknown): number

export declare const CHAT_ACK_TOO_FAST: string
export declare const CHAT_ACK_EMPTY: string
export declare const CHAT_ACK_NO_ROOM: string
export declare const CHAT_ACK_NOT_FOUND: string
export declare const CHAT_ACK_FAILED: string
export declare const CHAT_ACK_TIMEOUT_MS: number
/** null = 发出去了；'too-fast' = 太快被限流；'dropped' = 没发出去（房间散了 / 断线 / 超时） */
export declare function chatSendOutcome(err: unknown): 'too-fast' | 'dropped' | null
