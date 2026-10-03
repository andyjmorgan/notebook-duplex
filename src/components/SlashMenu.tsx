import type { ReactNode } from 'react'
import { Code, Heading1, Heading2, Heading3, Image, Link2, Quote, Sparkles, StickyNote, Table, Workflow } from 'lucide-react'

export const slashCommands: { command: string; icon: ReactNode; label: string; description: string }[] = [
  { command: 'agent', icon: <Sparkles size={16} />, label: 'Ask agent', description: 'Send a task to your Claude session' },
  { command: 'table', icon: <Table size={16} />, label: 'Table', description: 'Insert a text table' },
  { command: 'image', icon: <Image size={16} />, label: 'Image', description: 'Insert an image from a URL' },
  { command: 'tk', icon: <StickyNote size={16} />, label: 'Directive', description: 'Leave a [tk: …] note that fires when you close it' },
  { command: 'link', icon: <Link2 size={16} />, label: 'Wikilink', description: 'Link to another document by its title: [[Title]]' },
  { command: 'h1', icon: <Heading1 size={16} />, label: 'Heading 1', description: 'Large section heading' },
  { command: 'h2', icon: <Heading2 size={16} />, label: 'Heading 2', description: 'Section heading' },
  { command: 'h3', icon: <Heading3 size={16} />, label: 'Heading 3', description: 'Small section heading' },
  { command: 'quote', icon: <Quote size={16} />, label: 'Block quote', description: 'Set a quote apart' },
  { command: 'code', icon: <Code size={16} />, label: 'Code block', description: 'Insert formatted code' },
  { command: 'mermaid', icon: <Workflow size={16} />, label: 'Diagram', description: 'Mermaid diagram with live preview' },
]
export function slashChoices(text: string) { const q = text.slice(1).toLowerCase(); return slashCommands.filter(item => item.command.includes(q)) }

export function SlashMenu({ query, index, position, onPick }: { query: string; index: number; position: { top: number; left: number }; onPick: (command: string) => void }) {
  const choices = slashChoices(query)
  if (!choices.length) return null
  return (
    <div id="slash-menu" role="listbox" aria-label="Insert content" style={{ top: position.top, left: position.left }}>
      <div className="slash-heading">Insert</div>
      {choices.map((item, i) => (
        <button key={item.command} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} data-slash={item.command} onMouseDown={e => e.preventDefault()} onClick={() => onPick(item.command)}>
          <span className="slash-icon">{item.icon}</span>
          <span>{item.label}<small>{item.description}</small></span>
          <kbd>/{item.command}</kbd>
        </button>
      ))}
      <div className="slash-footer"><kbd>↑ ↓</kbd> navigate <kbd>↵</kbd> select <kbd>esc</kbd> close</div>
    </div>
  )
}
