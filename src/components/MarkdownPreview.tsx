import { createElement, type ReactNode } from 'react'

const markTag: Record<string, string> = { bold: 'strong', italic: 'em', code: 'code', strike: 's', underline: 'u', highlight: 'mark' }
function renderText(node: any, key: number): ReactNode {
  let out: ReactNode = node.text ?? ''
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link') out = <a key={key} href={mark.attrs?.href} target="_blank" rel="noopener noreferrer">{out}</a>
    else out = createElement(markTag[mark.type] ?? 'span', { key }, out)
  }
  return <span key={key}>{out}</span>
}
export function renderNodes(nodes: any[] | undefined): ReactNode[] {
  return (nodes ?? []).map((node, i) => {
    const children = () => renderNodes(node.content)
    switch (node.type) {
      case 'text': return renderText(node, i)
      case 'hardBreak': return <br key={i} />
      case 'paragraph': return <p key={i}>{children()}</p>
      case 'heading': return createElement(`h${Math.min(6, node.attrs?.level ?? 2)}`, { key: i }, children())
      case 'bulletList': return <ul key={i}>{children()}</ul>
      case 'orderedList': return <ol key={i} start={node.attrs?.start}>{children()}</ol>
      case 'listItem': case 'taskItem': return <li key={i}>{children()}</li>
      case 'taskList': return <ul key={i} className="task-list">{children()}</ul>
      case 'blockquote': return <blockquote key={i}>{children()}</blockquote>
      case 'codeBlock': return <pre key={i} data-language={node.attrs?.language ?? ''}><code>{(node.content ?? []).map((n: any) => n.text).join('')}</code></pre>
      case 'horizontalRule': return <hr key={i} />
      case 'image': return <img key={i} src={node.attrs?.src} alt={node.attrs?.alt ?? ''} title={node.attrs?.title ?? undefined} />
      case 'table': return <table key={i}><tbody>{children()}</tbody></table>
      case 'tableRow': return <tr key={i}>{children()}</tr>
      case 'tableHeader': return <th key={i} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{children()}</th>
      case 'tableCell': return <td key={i} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{children()}</td>
      default: return <div key={i}>{children()}</div>
    }
  })
}
export function MarkdownPreview({ markdown, parse, inline }: { markdown: string; parse: (md: string) => any[]; inline?: boolean }) {
  let nodes: any[] = []
  try { nodes = parse(markdown) } catch { return <pre className="preview-fallback">{markdown}</pre> }
  if (inline && nodes.length === 1 && nodes[0]?.content) return <div className="markdown-preview inline-preview">{renderNodes(nodes[0].content)}</div>
  return <div className="markdown-preview">{renderNodes(nodes)}</div>
}
