// Word-level diff producing equal / del / ins segments. Tokens keep their trailing whitespace so
// joining segments reproduces the original strings exactly.
export function tokenize(text) {
  return text.match(/\S+\s*|\s+/g) ?? []
}
export function diffWords(before, after, limit = 4000) {
  const a = tokenize(before), b = tokenize(after)
  if (a.length * b.length > limit * limit) return [{ type: 'del', text: before }, { type: 'ins', text: after }].filter(s => s.text)
  const n = a.length, m = b.length
  const table = new Uint16Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * (m + 1) + j] = a[i].trim() === b[j].trim() ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1])
  }
  const segments = []
  const push = (type, text) => { const last = segments[segments.length - 1]; if (last && last.type === type) last.text += text; else segments.push({ type, text }) }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i].trim() === b[j].trim()) { push('equal', b[j]); i++; j++ }
    else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) { push('del', a[i]); i++ }
    else { push('ins', b[j]); j++ }
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('ins', b[j++])
  return segments
}
