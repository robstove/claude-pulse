// Draws docs/screenshot.png from the pane as the code draws it now, for a made-up session (scripts/screenshot/pane.shot.tsx).
// The test kit gives the drawn element tree; this script lays it out as HTML in the desktop app's dark colors and
// screenshots it with Playwright. Run: node scripts/screenshot.mjs (needs `claude` on PATH and the playwright package).
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = join(root, 'docs', 'screenshot.png')
const MARK = 'PULSE_SCREENSHOT '

const GAP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
const SIZE = { title: [22, 600], heading: [16, 600], body: [14, 400], footnote: [13, 400], caption: [12, 400] }
const COLOR = { success: '#3fb950', warning: '#d29922', error: '#f85149', suggestion: '#58a6ff', claude: '#d97757' }
const TEXT = '#e6e6e6'
const MUTED = '#8b949e'
const BACKGROUND = '#1e1e1e'

function drawnTree() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-shot-'))
  try {
    for (const part of ['.claude-plugin', 'hooks', 'types']) cpSync(join(root, part), join(dir, part), { recursive: true })
    cpSync(join(root, 'tsconfig.json'), join(dir, 'tsconfig.json'))
    cpSync(join(root, 'scripts', 'screenshot', 'pane.shot.tsx'), join(dir, 'tests', 'screenshot.test.tsx'))
    // On Windows `claude` can be a .cmd shim, which only a shell runs; the temporary folder path holds no quote.
    // A hung test run fails after 5 minutes; TZ=UTC keeps the History days the same on every machine.
    const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, env: { ...process.env, TZ: 'UTC' } }
    const run =
      process.platform === 'win32'
        ? spawnSync(`claude plugin test "${dir}"`, { ...options, shell: true })
        : spawnSync('claude', ['plugin', 'test', dir], options)
    const text = `${run.stdout}\n${run.stderr}`
    const line = text.split('\n').find(l => l.includes(MARK))
    if (run.error || run.status !== 0 || line === undefined) {
      throw new Error(`the screenshot test failed: ${run.error?.message ?? `exit ${run.status}`}\n${text.slice(-4000)}`)
    }
    return JSON.parse(line.slice(line.indexOf(MARK) + MARK.length))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const gap = v => (typeof v === 'number' ? v : (GAP[v] ?? 0))
const length = v => (typeof v === 'number' ? `${v}px` : v)

function html(node, inText = false) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(n => html(n, inText)).join('')
  const p = node.props ?? {}
  const kids = node.children ?? []
  // The Svg source goes in raw: it is markup that Pulse's own chart code builds, never text from a session.
  if (node.type === 'Svg') return `<div style="width:${length(p.width)};height:${length(p.height)};flex:none">${p.source}</div>`
  if (node.type === 'Text') {
    const [size, weight] = SIZE[p.size] ?? (inText ? [] : SIZE.body)
    const style = [
      size ? `font-size:${size}px` : '',
      p.bold || p.weight === 'semibold' || weight === 600 ? 'font-weight:600' : '',
      p.color ? `color:${COLOR[p.color] ?? p.color}` : p.dimColor ? `color:${MUTED}` : '',
      p.tabular ? 'font-variant-numeric:tabular-nums' : '',
      inText ? '' : 'white-space:pre-wrap',
    ]
    return `<span style="${style.filter(Boolean).join(';')}">${html(kids, true)}</span>`
  }
  const style = [
    'display:flex',
    `flex-direction:${p.flexDirection ?? 'row'}`,
    p.justifyContent ? `justify-content:${p.justifyContent}` : '',
    p.alignItems ? `align-items:${p.alignItems}` : '',
    p.flexWrap ? `flex-wrap:${p.flexWrap}` : '',
    p.gap !== undefined ? `gap:${gap(p.gap)}px` : '',
    p.columnGap !== undefined ? `column-gap:${gap(p.columnGap)}px` : '',
    p.rowGap !== undefined ? `row-gap:${gap(p.rowGap)}px` : '',
    p.width !== undefined ? `width:${length(p.width)};flex:none` : '',
  ]
  return `<div style="${style.filter(Boolean).join(';')}">${html(kids)}</div>`
}

const page = tree => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: ${BACKGROUND}; }
  #pane { width: 448px; background: ${BACKGROUND}; color: ${TEXT}; font: 14px/1.45 Inter, "Segoe UI", system-ui, -apple-system, sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid #333; font-size: 14px; }
  main { padding: 16px; }
  svg { display: block; }
</style><div id="pane"><header>Pulse</header><main>${html(tree)}</main></div>`

const { chromium } = await import('playwright')
// PULSE_BROWSER names an installed browser (msedge, chrome) when Playwright's own Chromium is not downloaded.
const browser = await chromium.launch(process.env.PULSE_BROWSER ? { channel: process.env.PULSE_BROWSER } : {})
try {
  const tab = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 448, height: 800 } })
  await tab.setContent(page(drawnTree()))
  writeFileSync(out, await tab.locator('#pane').screenshot())
  console.log(`wrote ${out}`)
} finally {
  await browser.close()
}
