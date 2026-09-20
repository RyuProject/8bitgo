import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { register } from 'node:module'
export const root = process.env.AUDIT_TARGET || fileURLToPath(new URL('../../', import.meta.url))
export const load = file => import(pathToFileURL(path.join(root, file)).href)
export function stubs(replacements) {
  register('data:text/javascript,' + encodeURIComponent(`
    const map = ${JSON.stringify(replacements)};
    export async function resolve(specifier, context, next) {
      for (const [suffix, source] of Object.entries(map)) {
        if (specifier.endsWith(suffix)) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return next(specifier, context);
    }
  `))
}
