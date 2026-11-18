// Lists the events Pulse hooks, the engine calls it makes, and the environment it touches, as `claude plugin validate --json`
// reads them. Fails when the list differs from scripts/surface.txt, and on any call outside the session.
// Run: node scripts/check-surface.mjs [--write]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const listPath = join(root, 'scripts', 'surface.txt')
const OUTSIDE = /^(fs|process|model|agent|tool|audio|net|shell)\./

// One fixed command string through a shell, because the CLI is a .cmd shim on Windows that only a shell starts.
const run = spawnSync('claude plugin validate --json .', { cwd: root, encoding: 'utf8', shell: true })
let report
try {
  report = JSON.parse(run.stdout)
} catch {
  console.error(`claude plugin validate --json gave no report (exit ${run.status}):\n${run.stderr || run.stdout}`)
  process.exit(1)
}

const modules = (report.contents ?? []).flatMap(c => c.modules ?? [])
if (modules.length === 0) {
  console.error('claude plugin validate --json reports no hooks module. Its modules field needs Claude Code 2.1.326 or later.')
  process.exit(1)
}

const found = new Set()
const problems = []
for (const { module, uses } of modules) {
  for (const e of uses.events) found.add(`hook ${e}`)
  for (const c of uses.calls) {
    found.add(`call $.${c}`)
    if (OUTSIDE.test(c)) problems.push(`${module} reaches outside the session: $.${c}`)
  }
  for (const v of uses.env.reads) found.add(`env read ${v}`)
  for (const v of uses.env.writes) found.add(`env write ${v}`)
}

const now = [...found].sort()
if (process.argv.includes('--write')) {
  writeFileSync(listPath, `${now.join('\n')}\n`)
  console.log(`wrote ${now.length} entries to scripts/surface.txt`)
} else {
  const listed = readFileSync(listPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (const entry of now.filter(e => !listed.includes(e))) problems.push(`not in scripts/surface.txt: ${entry}`)
  for (const entry of listed.filter(e => !now.includes(e))) problems.push(`in scripts/surface.txt but no longer used: ${entry}`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error('Review the change, then run node scripts/check-surface.mjs --write when it is intended.')
  process.exit(1)
}
console.log(`surface ok: ${now.length} entries`)
