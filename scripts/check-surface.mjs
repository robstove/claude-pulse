// Lists every event Pulse hooks and every engine call it makes, and fails when that list differs from scripts/surface.txt,
// so a new hook or call shows in the pull request. Calls that reach outside the session fail whatever the file says.
// Run: node scripts/check-surface.mjs [--write]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const listPath = join(root, 'scripts', 'surface.txt')
const FORBIDDEN = /\$\.(fs|process|model|agent|tool|audio|net|shell)\.|\bfetch\(/

const found = new Set()
const problems = []
for (const name of readdirSync(join(root, 'hooks')).filter(n => /\.tsx?$/.test(n)).sort()) {
  const text = readFileSync(join(root, 'hooks', name), 'utf8')
  for (const m of text.matchAll(/\bon\(\s*'([\w.]+)'/g)) found.add(`hook ${m[1]}`)
  for (const m of text.matchAll(/\$\.(\w+)\.(\w+)\(/g)) found.add(`call $.${m[1]}.${m[2]}`)
  text.split('\n').forEach((line, i) => {
    if (FORBIDDEN.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) problems.push(`hooks/${name}:${i + 1} reaches outside the session: ${line.trim()}`)
  })
}

const now = [...found].sort()
if (process.argv.includes('--write')) {
  writeFileSync(listPath, `${now.join('\n')}\n`)
  console.log(`wrote ${now.length} entries to scripts/surface.txt`)
} else {
  const listed = readFileSync(listPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  for (const entry of now.filter(e => !listed.includes(e))) problems.push(`not in scripts/surface.txt: ${entry}`)
  for (const entry of listed.filter(e => !now.includes(e))) problems.push(`in scripts/surface.txt but no longer used: ${entry}`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error('Review the change, then run node scripts/check-surface.mjs --write when it is intended.')
  process.exit(1)
}
console.log(`surface ok: ${now.length} entries`)
