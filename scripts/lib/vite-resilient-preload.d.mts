import type { Plugin } from 'vite'

export declare const PRELOAD_HELPER_ID: string
export declare const RESILIENT_PRELOAD_MARKER: string
export declare const PRELOAD_FAILURE_PROP: string
export declare const RESILIENT_PRELOAD_CODE: string
export declare function patchPreloadHelper(code: string): string | null
export declare function resilientPreloadPlugin(): Plugin
