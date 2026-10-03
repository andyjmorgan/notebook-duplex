import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronRight, Folder, Hash, SlidersHorizontal, X } from 'lucide-react'
import type { DocumentMeta, TagCount } from '../types'

export type HeaderProps = {
  meta: DocumentMeta | undefined
  titleRef: RefObject<HTMLInputElement | null>
  readOnly: boolean
  onTitleInput: () => void
  onTitleCommit: (title: string) => void
  onMove: () => void
  onTags: (tags: string[]) => Promise<void>
  onFrontmatter: (frontmatter: Record<string, unknown>) => Promise<void>
  tagSuggestions: TagCount[]
}
export const slugifyTag = (s: string) => s.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '')

export function DocumentHeader({ meta, titleRef, readOnly, onTitleInput, onTitleCommit, onMove, onTags, onFrontmatter, tagSuggestions }: HeaderProps) {
  const segments = (meta?.folder ?? '/').split('/').filter(Boolean)
  return (
    <div className="document-heading">
      <div className="breadcrumb">
        <button className="crumb" onClick={onMove} title="Move to another folder" disabled={!meta}><Folder size={13} aria-hidden /> Library</button>
        {segments.map((s, i) => <span key={i} className="crumb-seg"><ChevronRight size={12} aria-hidden /><button className="crumb" onClick={onMove} disabled={!meta}>{s}</button></span>)}
      </div>
      <input ref={titleRef} aria-label="Document title" defaultValue="" placeholder="Untitled" readOnly={readOnly} onInput={onTitleInput} onBlur={e => onTitleCommit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }} />
      <TagInput tags={meta?.tags ?? []} suggestions={tagSuggestions} disabled={!meta || readOnly} onChange={onTags} />
      <Properties meta={meta} disabled={!meta || readOnly} onSave={onFrontmatter} />
    </div>
  )
}

/** Tag chips: type to add (Enter or comma commits), Backspace on an empty field removes the last one. */
export function TagInput({ tags, suggestions, disabled, onChange }: { tags: string[]; suggestions: TagCount[]; disabled: boolean; onChange: (tags: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const commit = async (next: string[]) => { try { setError(''); await onChange(next) } catch (e) { setError((e as Error).message) } }
  const add = (raw: string) => { const tag = slugifyTag(raw); setDraft(''); if (tag && !tags.includes(tag)) void commit([...tags, tag]) }
  const matches = draft ? suggestions.filter(s => s.tag.includes(slugifyTag(draft)) && !tags.includes(s.tag)).slice(0, 6) : []
  return (
    <div className={`tag-input ${disabled ? 'disabled' : ''}`} onClick={() => input.current?.focus()}>
      <Hash size={13} aria-hidden className="tag-input-icon" />
      {tags.map(t => <span key={t} className="tag-chip on">{t}{!disabled && <button aria-label={`Remove tag ${t}`} onClick={e => { e.stopPropagation(); void commit(tags.filter(x => x !== t)) }}><X size={11} aria-hidden /></button>}</span>)}
      {!disabled && <input ref={input} list="tag-suggestions" value={draft} placeholder={tags.length ? 'Add tag' : 'Add tags'} aria-label="Add tag" onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft.trim()) add(draft) }} onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' && draft) { e.preventDefault(); add(draft) }
        else if (e.key === 'Backspace' && !draft && tags.length) { e.preventDefault(); void commit(tags.slice(0, -1)) }
        else if (e.key === 'Escape') setDraft('')
      }} />}
      <datalist id="tag-suggestions">{matches.map(m => <option key={m.tag} value={m.tag}>{m.count} documents</option>)}</datalist>
      {error && <span className="gate-error">{error}</span>}
    </div>
  )
}

/** The full front matter as YAML. Saving writes `frontmatter`; the server derives title, tags and folder from it. */
type Yaml = typeof import('yaml')
let yamlModule: Promise<Yaml> | undefined
const loadYaml = () => yamlModule ??= import('yaml')
function Properties({ meta, disabled, onSave }: { meta: DocumentMeta | undefined; disabled: boolean; onSave: (fm: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [yaml, setYaml] = useState<Yaml>()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (open && !yaml) void loadYaml().then(setYaml) }, [open, yaml])
  const serialised = meta && yaml ? yaml.stringify(fullFrontmatter(meta)).trimEnd() : ''
  useEffect(() => { if (!dirty) { setText(serialised); setError('') } }, [serialised, dirty])
  const validate = (value: string): Record<string, unknown> | undefined => {
    if (!yaml) return
    try {
      const parsed = value.trim() ? yaml.parse(value) : {}
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { setError('Front matter must be a YAML mapping (key: value lines).'); return }
      if ('tags' in parsed && parsed.tags != null && !Array.isArray(parsed.tags) && typeof parsed.tags !== 'string') { setError('`tags` must be a list.'); return }
      setError(''); return parsed as Record<string, unknown>
    } catch (e) { setError((e as Error).message.split('\n')[0]); return }
  }
  const save = async () => {
    const parsed = validate(text)
    if (!parsed) return
    setBusy(true)
    try { await onSave(parsed); setDirty(false) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <details className="properties" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><SlidersHorizontal size={13} aria-hidden /> Properties{meta && Object.keys(meta.frontmatter ?? {}).filter(k => !['title', 'tags', 'folder'].includes(k)).length > 0 && <span className="caption"> · {Object.keys(meta.frontmatter).filter(k => !['title', 'tags', 'folder'].includes(k)).join(', ')}</span>}</summary>
      {open && (
        <div className="properties-body">
          <textarea aria-label="Front matter (YAML)" value={text} spellCheck={false} rows={Math.min(16, Math.max(4, text.split('\n').length + 1))} disabled={disabled || !yaml} onChange={e => { setText(e.target.value); setDirty(true); validate(e.target.value) }} />
          {error ? <p className="gate-error" role="alert">{error}</p> : <p className="caption">Known keys: title, tags, folder, aliases, created, updated. Anything else is kept as is.</p>}
          <div className="dialog-actions"><button className="quiet small" disabled={!dirty} onClick={() => { setDirty(false); setText(serialised); setError('') }}>Revert</button><button className="primary small" disabled={disabled || busy || !dirty || Boolean(error)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save properties'}</button></div>
        </div>
      )}
    </details>
  )
}
/** The YAML the writer sees: derived fields first, then everything the server kept verbatim. */
export function fullFrontmatter(meta: DocumentMeta): Record<string, unknown> {
  const { title: _t, tags: _g, folder: _f, ...rest } = meta.frontmatter ?? {}
  return { title: meta.title, tags: meta.tags, folder: meta.folder, ...rest }
}
