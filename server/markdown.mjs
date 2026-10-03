import YAML from 'yaml'
import { MarkdownManager, Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { textOf } from './store.mjs'

// Headless Tiptap Markdown: the same parser the editor uses, so server-side imports and exports match the browser.
const manager = new MarkdownManager({ extensions: [StarterKit, Table, TableRow, TableCell, TableHeader, Image.configure({ inline: true, allowBase64: true }), Markdown] })
export const KNOWN_KEYS = ['title', 'tags', 'folder', 'aliases', 'created', 'updated']

export function markdownToJson(markdown) { return manager.parse(String(markdown ?? '')) }
export function jsonToMarkdown(json) {
  if (!json || json.type !== 'doc') return ''
  // The serializer escapes brackets, which would break wikilinks on round trip.
  return manager.serialize(json).replace(/\\\[\\\[([^\]]+?)\\\]\\\]/g, '[[$1]]').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
// Splits a leading YAML block from the body. Unknown keys are kept verbatim.
export function parseFrontMatter(markdown) {
  const text = String(markdown ?? '').replace(/^﻿/, '')
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { frontmatter: {}, body: text }
  let data
  try { data = YAML.parse(match[1]) } catch { return { frontmatter: {}, body: text } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { frontmatter: {}, body: text }
  return { frontmatter: data, body: text.slice(match[0].length) }
}
export function withFrontMatter(frontmatter, body) {
  const data = Object.fromEntries(Object.entries(frontmatter ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)))
  const yaml = Object.keys(data).length ? '---\n' + YAML.stringify(data, { lineWidth: 0 }).trimEnd() + '\n---\n\n' : ''
  return yaml + String(body ?? '').replace(/^\n+/, '')
}
export function plainText(json) {
  const parts = []
  const walk = node => { if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) parts.push(textOf(node)); else for (const child of node.content ?? []) walk(child) }
  for (const child of json?.content ?? []) walk(child)
  return parts.filter(Boolean).join('\n').replace(/ /g, ' ')
}
export const wordCount = text => (String(text).match(/\S+/g) ?? []).length
export const wikilinks = text => [...new Set([...String(text).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim()).filter(Boolean))]
// Title from the first heading when the body has one; the fallback is the first words of the text.
export function titleFrom(json, fallback = 'Untitled') {
  const heading = (json?.content ?? []).find(n => n.type === 'heading')
  const text = heading ? textOf(heading).trim() : ''
  return text || fallback
}
