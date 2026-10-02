// Narration text rules shared by the browser (script builder) and the server (describe fallbacks, tests).

// Abbreviations that never end a sentence, and ones that may when the next word is capitalised.
const NEVER_BREAK = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'e.g', 'i.e', 'cf', 'fig', 'no', 'approx', 'dept', 'est', 'ca', 'u.s', 'u.k', 'a.m', 'p.m'])
const SOFT_BREAK = new Set(['etc', 'inc', 'ltd', 'co', 'al'])
const MIN_SENTENCE = 12

/** @param {string} text @returns {{ text: string; start: number; end: number }[]} */
export function splitSentences(text) {
  const out = []
  const push = (start, end) => {
    const raw = text.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (!trimmed) return
    const last = out[out.length - 1]
    if (last && last.text.length < MIN_SENTENCE) { last.text = text.slice(last.start, end).trim(); last.end = end; return }
    out.push({ text: trimmed, start: start + lead, end: start + lead + trimmed.length })
  }
  const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g
  let start = 0, m
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length
    const before = text.slice(start, m.index)
    const word = (before.match(/(\S+)$/)?.[1] ?? '').toLowerCase().replace(/^[("'“‘[]+/, '')
    const next = text.slice(end).match(/^\s+(\S)/)?.[1]
    if (m[0][0] === '.' && next !== undefined) {
      const initial = /^[a-z]$/.test(word) || /^(?:[a-z]\.)+[a-z]?$/.test(word)
      if (NEVER_BREAK.has(word) || initial) continue
      if (SOFT_BREAK.has(word) && !/[A-Z"“(\[]/.test(next)) continue
    }
    push(start, end); start = end
  }
  push(start, text.length)
  return out
}

/** @param {string | null | undefined} alt @param {boolean} [inline] */
export function imageText(alt, inline = false) {
  const clean = (alt ?? '').trim().replace(/\s+/g, ' ')
  const text = clean ? `an image of ${clean}` : 'an image'
  return inline ? text : text[0].toUpperCase() + text.slice(1)
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
/** @param {number} columns @param {number} rows body rows (header excluded) */
export function tableIntro(columns, rows) { return `A table with ${plural(columns, 'column')} and ${plural(rows, 'row')}.` }
/** @param {(string | null | undefined)[] | null} headers @param {number} count */
export function columnTitles(headers, count) { return Array.from({ length: count }, (_, i) => (headers?.[i] ?? '').trim() || `Column ${i + 1}`) }
/** @param {string[]} titles @param {(string | null | undefined)[]} cells */
export function tableRowText(titles, cells) {
  return titles.map((title, i) => {
    const value = (cells[i] ?? '').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '') || 'blank'
    return `${title.replace(/[.:]+$/, '')}: ${value}.`
  }).join(' ')
}

const LANGUAGE_NAMES = { js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript', py: 'Python', python: 'Python', bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', sql: 'SQL', html: 'HTML', css: 'CSS', csharp: 'C sharp', cs: 'C sharp', go: 'Go', rust: 'Rust', rs: 'Rust', markdown: 'Markdown', md: 'Markdown', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', ruby: 'Ruby', php: 'PHP', c: 'C', cpp: 'C plus plus', 'c++': 'C plus plus', toml: 'TOML', xml: 'XML', dockerfile: 'Dockerfile' }
/** @param {string | null | undefined} language */
export function languageName(language) { const key = (language ?? '').trim().toLowerCase(); return key ? LANGUAGE_NAMES[key] ?? key : '' }
/** @param {string | null | undefined} language */
export function codeIntro(language) { const name = languageName(language); return name ? `A ${name} code block` : 'A code block' }
/** @param {string | null | undefined} language @param {string} source */
export function describeCodeFallback(language, source) { const lines = source.split('\n').filter(l => l.trim()).length; return `${codeIntro(language)} with ${plural(lines, 'line')}.` }

const DIAGRAM_KINDS = [
  [/^(flowchart|graph)\b/i, 'flowchart'], [/^sequenceDiagram/i, 'sequence diagram'], [/^classDiagram/i, 'class diagram'], [/^stateDiagram/i, 'state diagram'],
  [/^erDiagram/i, 'entity relationship diagram'], [/^mindmap/i, 'mind map'], [/^gantt/i, 'Gantt chart'], [/^pie\b/i, 'pie chart'], [/^journey/i, 'user journey'],
  [/^gitGraph/i, 'git graph'], [/^timeline/i, 'timeline'], [/^quadrantChart/i, 'quadrant chart'], [/^xychart/i, 'chart'], [/^block/i, 'block diagram'], [/^C4/i, 'C4 diagram'], [/^requirement/i, 'requirement diagram'], [/^sankey/i, 'Sankey diagram'], [/^architecture/i, 'architecture diagram'], [/^kanban/i, 'kanban board'], [/^packet/i, 'packet diagram'],
]
/** @param {string} source */
export function diagramBody(source) { return source.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim() }
/** @param {string} source */
export function diagramKindName(source) {
  const first = diagramBody(source).split('\n')[0]?.trim() ?? ''
  return DIAGRAM_KINDS.find(([re]) => re.test(first))?.[1] ?? 'diagram'
}
const unwrap = s => s.replace(/^["'`]+|["'`]+$/g, '').trim()
/** Node labels in document order, de-duplicated by id. @param {string} source @returns {string[]} */
export function diagramNodes(source) {
  const kind = diagramKindName(source)
  const lines = diagramBody(source).split('\n').slice(1).map(l => l.replace(/%%.*$/, '').trim()).filter(Boolean)
  const seen = new Map()
  if (kind === 'flowchart') {
    for (const line of lines) {
      if (/^(subgraph|end$|direction|style|classDef|class |click|linkStyle)/i.test(line)) continue
      for (const part of line.split(/\s*(?:[-=.]+>[>ox]?|<[-=.]+>?|[-=]{2,}|-\.-|\|[^|]*\||&)\s*/).filter(Boolean)) {
        const m = part.match(/^([A-Za-z0-9_]+)(?:\s*(?:\[\[?|\(\(?|\{\{?|>|\[\/|\[\\|\(\[|\[\()\s*("?)([^\]\)\}]*?)\2\s*(?:\]\]?|\)\)?|\}\}?|\/\]|\\\]|\]\)|\)\]))?\s*(?::::\w+)?$/)
        if (!m) continue
        const label = unwrap(m[3] ?? '') || m[1]
        if (!seen.has(m[1])) seen.set(m[1], label)
      }
    }
  } else if (kind === 'mind map') {
    for (const line of lines) { const label = unwrap(line.replace(/^[^\s(\[{]*\s*[\(\[\{]+/, '').replace(/[\)\]\}]+\s*$/, '')) || line; if (!seen.has(label)) seen.set(label, label) }
  } else if (kind === 'sequence diagram') {
    for (const line of lines) {
      const declared = line.match(/^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?/i)
      if (declared) { if (!seen.has(declared[1])) seen.set(declared[1], unwrap(declared[2] ?? declared[1])); continue }
      const edge = line.match(/^(\S+?)\s*(?:-{1,2}>>?|-[x)]|--?\)|-{1,2}x)\s*([^:]+?)\s*:/)
      if (edge) for (const id of [edge[1], edge[2]]) if (!seen.has(id)) seen.set(id, id)
    }
  } else if (kind === 'state diagram' || kind === 'class diagram' || kind === 'entity relationship diagram') {
    for (const line of lines) for (const m of line.matchAll(/^([A-Za-z0-9_]+)|(?:-->|--|\|\|--|o\{|\|\{|\.\.|<\|--)\s*([A-Za-z0-9_]+)/g)) { const id = m[1] ?? m[2]; if (id && !/^(class|state|note|end|direction)$/i.test(id) && !seen.has(id)) seen.set(id, id) }
  } else if (kind === 'pie chart') {
    for (const line of lines) { const m = line.match(/^"([^"]+)"\s*:/); if (m && !seen.has(m[1])) seen.set(m[1], m[1]) }
  }
  return [...seen.values()]
}
/** Deterministic description used when no LLM is reachable. @param {string} source */
export function describeDiagramFallback(source) {
  const kind = diagramKindName(source)
  const nodes = diagramNodes(source)
  const article = /^[aeiou]/i.test(kind) ? 'an' : 'a'
  if (!nodes.length) return `${article} ${kind}.`
  const unit = kind === 'sequence diagram' ? 'participant' : kind === 'pie chart' ? 'slice' : 'node'
  const shown = nodes.slice(0, 12).join(', ') + (nodes.length > 12 ? ', and more' : '')
  return `${article} ${kind} with ${plural(nodes.length, unit)}: ${shown}.`
}
/** @param {string} description */
export function diagramUtterance(description) {
  let d = description.trim().replace(/\s+/g, ' ')
  d = d.replace(/^(?:this (?:is )?)?(?:a )?(?:chart or diagram|diagram|chart)\s+(?:showing|shows|that shows|depicting|of)\s+/i, '')
  if (!d) return 'A chart or diagram.'
  if (!/[.!?]$/.test(d)) d += '.'
  return `A chart or diagram showing ${d[0].toLowerCase()}${d.slice(1)}`
}
/** @param {string | null | undefined} language @param {string} summary */
export function codeUtterance(language, summary) {
  const s = summary.trim().replace(/\s+/g, ' ')
  if (!s) return `${codeIntro(language)}.`
  return `${codeIntro(language)}. ${s[0].toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`
}
/** Strip markdown and fences from model output so it can be spoken. @param {string} text */
export function spokenText(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 700)
}
