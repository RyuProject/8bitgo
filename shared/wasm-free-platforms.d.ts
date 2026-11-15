/** wasm-free-platforms.js 的类型声明。改了导出记得同步这里。 */
export declare const WASM_FREE_PLATFORM_IDS: readonly string[]
export declare const WASM_FREE_GAME_SLUGS: readonly string[]
export declare function platformRunsWithoutWasm(id: string | undefined | null): boolean
export declare function gameRunsWithoutWasm(platform: string | undefined | null, slug: string | undefined | null): boolean
export declare function platformHasWasmFreeGames(platform: string | undefined | null): boolean
