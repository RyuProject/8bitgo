/** awayfl-games.js 的类型声明。改了导出记得同步这里。 */
export declare const AWAYFL_TEST_CANDIDATES: readonly string[]
export declare const AWAYFL_TEST_RESULTS: readonly {
  slug: string
  status: 'untested' | 'verified' | 'start-failure' | 'black-screen' | 'input-failure'
  note: string
}[]
export declare const AWAYFL_VERIFIED_GAMES: readonly string[]
export declare function awayflVerifiedGame(slug: string | undefined | null): boolean
