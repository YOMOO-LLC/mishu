/** Minimal glob matcher for snapshot include/exclude rules. */

const cache = new Map()

export function globToRegExp(glob) {
  const g = String(glob).replaceAll('\\', '/').replace(/^\.\//, '')
  let re = ''
  let i = 0
  while (i < g.length) {
    if (g.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
      continue
    }
    if (g.startsWith('**', i) && (i + 2 === g.length || g[i + 2] === '/')) {
      re += '.*'
      i += 2
      continue
    }
    const ch = g[i]
    if (ch === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if ('\\^$+()[]{}|.'.includes(ch)) re += `\\${ch}`
    else re += ch
    i += 1
  }
  return new RegExp(`^${re}$`)
}

export function matchGlob(filePath, glob) {
  const path = String(filePath).replaceAll('\\', '/').replace(/^\.\//, '')
  let re = cache.get(glob)
  if (!re) {
    re = globToRegExp(glob)
    cache.set(glob, re)
  }
  return re.test(path)
}

export function matchesAnyGlob(filePath, globs) {
  return globs.some((glob) => matchGlob(filePath, glob))
}
