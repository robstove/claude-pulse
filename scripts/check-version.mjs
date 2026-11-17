// Fails when the version in hooks/version.ts, which the pane title shows, differs from the one in .claude-plugin/plugin.json.
// Run: node scripts/check-version.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
const shown = /export const VERSION = '([^']+)'/.exec(readFileSync(join(root, 'hooks', 'version.ts'), 'utf8'))?.[1]

if (shown !== manifest) {
  console.error(`hooks/version.ts says ${shown ?? 'nothing'}, but .claude-plugin/plugin.json says ${manifest}. Set both to the same version.`)
  process.exit(1)
}
console.log(`version ok: ${manifest}`)
