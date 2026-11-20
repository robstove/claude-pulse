// A call's label holds a name, never content: the model's description, a command's program, a path's last two parts, or a host.
// A pattern, query, or prompt gives no label, because each one is content.

const cut = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** The program a command line runs: no `cd` prefix, no `NAME=value` assignment, no arguments, no folder. */
const commandName = (command: string): string => {
  // A leading `cd <dir> &&` names only where the command ran.
  const line = (command.trim().split('\n')[0] ?? '').replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, '')
  // A shell word joins its quoted parts, so `A="x y"` stays one word; an unclosed quote runs to the end of the line.
  const words = line.match(/(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'])+/g) ?? []
  // An assignment before the program can carry a token, so it never reaches the label.
  const program = words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''
  return program.replace(/["']/g, '').split(/[\\/]/).pop() ?? ''
}

/** The last two parts of a path, which say which file without a long absolute path. */
export const shortPath = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

/** The host of an address, without login, path, or query; empty when the text is not an address. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export const callLabel = (input: Readonly<Record<string, unknown>>): string => {
  const text = (key: string): string => {
    const v = input[key]
    return typeof v === 'string' ? v.trim() : ''
  }
  const description = text('description')
  if (description !== '') return cut(description.split('\n')[0] ?? '')
  const command = text('command')
  if (command !== '') return cut(commandName(command))
  const path = text('file_path') || text('notebook_path')
  if (path !== '') return cut(shortPath(path))
  const url = text('url')
  return url !== '' ? hostOf(url) : ''
}
