// Releases a new version: raises it in the manifest, regenerates hooks/version.ts, runs the checks, commits and pushes to main,
// waits for the CI check run of that commit, then tags it with `claude plugin tag --push`. Needs git, gh, and claude.
// Run: node scripts/release.mjs <patch|minor|major|x.y.z> [--github-release] [--dry-run]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const MANIFEST = '.claude-plugin/plugin.json'
const GENERATED = 'hooks/version.ts'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const githubRelease = args.includes('--github-release')
const level = args.find(a => !a.startsWith('--'))

const fail = message => {
  console.error(`release stopped: ${message}`)
  process.exit(1)
}

// Every command is a fixed string plus a version that SEMVER has checked, so the shell sees no outside text.
// A shell is needed because claude is a .cmd shim on Windows.
const run = (command, { quiet = false } = {}) => {
  if (!quiet) console.log(`> ${command}`)
  const r = spawnSync(command, { cwd: root, encoding: 'utf8', shell: true, stdio: quiet ? 'pipe' : 'inherit' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}
const must = (command, options) => {
  const r = run(command, options)
  if (!r.ok) fail(`${command} failed`)
  return r.out
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const read = path => readFileSync(join(root, path), 'utf8')
const current = JSON.parse(read(MANIFEST)).version
const parts = SEMVER.exec(current)?.slice(1).map(Number)
if (!parts) fail(`${MANIFEST} version ${current} is not x.y.z`)
const [major, minor, patch] = parts
const next =
  level === 'patch' ? `${major}.${minor}.${patch + 1}`
  : level === 'minor' ? `${major}.${minor + 1}.0`
  : level === 'major' ? `${major + 1}.0.0`
  : level
if (!next || !SEMVER.test(next)) fail('give patch, minor, major, or a version x.y.z')
if (next.localeCompare(current, undefined, { numeric: true }) <= 0) fail(`${next} is not above ${current}`)

// 1. A release starts from main at origin/main with no changes, so the commit holds the bump and nothing else.
if (must('git rev-parse --abbrev-ref HEAD', { quiet: true }) !== 'main') fail('check out main first')
if (must('git status --porcelain', { quiet: true }) !== '') fail('commit or set aside the changes in the tree first')
must('git fetch --quiet origin main', { quiet: true })
if (must('git rev-parse HEAD', { quiet: true }) !== must('git rev-parse origin/main', { quiet: true })) fail('main differs from origin/main; pull or push first')
if (must(`git tag --list pulse--v${next}`, { quiet: true }) !== '') fail(`tag pulse--v${next} exists`)

// 2. The bump replaces only the version text, so the manifest keeps its layout and line ends.
const before = { [MANIFEST]: read(MANIFEST), [GENERATED]: read(GENERATED) }
const restore = () => Object.entries(before).forEach(([path, text]) => writeFileSync(join(root, path), text))
const bumped = before[MANIFEST].replace(`"version": "${current}"`, `"version": "${next}"`)
if (JSON.parse(bumped).version !== next) fail(`${MANIFEST} has no "version": "${current}" to replace`)
writeFileSync(join(root, MANIFEST), bumped)
console.log(`${current} -> ${next}`)

// 3. The same checks as CI; a failure puts both files back.
for (const check of ['node scripts/version.mjs --write', 'claude plugin validate --strict .', 'claude plugin test .', 'node scripts/check-surface.mjs', 'node scripts/version.mjs']) {
  if (!run(check).ok) {
    restore()
    fail(`${check} failed; the version is back at ${current}`)
  }
}
if (dryRun) {
  restore()
  console.log(`dry run ok: ${next} passes the checks; nothing was committed, and the version is back at ${current}`)
  process.exit(0)
}

// 4. Commit by name and push.
const files = `${MANIFEST} ${GENERATED}`
must(`git commit --quiet --only -m "release: Pulse ${next}" -- ${files}`)
const sha = must('git rev-parse HEAD', { quiet: true })
must('git push --quiet origin main')

// 5. The tag goes on a commit CI passed. GitHub can take a few seconds to list the run of a new push.
let id = ''
for (let i = 0; i < 30 && id === ''; i++) {
  id = run(`gh run list --workflow check.yml --commit ${sha} --json databaseId --jq ".[0].databaseId"`, { quiet: true }).out
  if (id === '') spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'])
}
if (id === '') fail(`no CI check run for ${sha.slice(0, 7)}; tag it by hand with claude plugin tag --push once CI passes`)
if (!run(`gh run watch ${id} --exit-status`, { quiet: true }).ok) fail(`CI failed for ${sha.slice(0, 7)}: gh run view ${id} --log-failed`)
console.log(`CI passed for ${sha.slice(0, 7)}`)

// 6. Tag, and on request a GitHub release with notes from the commits since the last tag.
must('claude plugin tag --push .')
if (githubRelease) must(`gh release create pulse--v${next} --verify-tag --generate-notes --title "Pulse ${next}"`)
console.log(`released Pulse ${next}`)
