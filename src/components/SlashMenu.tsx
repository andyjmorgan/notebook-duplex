export const slashCommands = [
  { command: 'agent', icon: '✦', label: 'Ask agent', description: 'Send a task to your Claude session' },
  { command: 'table', icon: '▦', label: 'Table', description: 'Insert a text table' },
  { command: 'image', icon: '▣', label: 'Image', description: 'Insert an image from a URL' },
  { command: 'tk', icon: '⌁', label: 'Directive', description: 'Leave a [tk: …] note that fires when you close it' },
  { command: 'h1', icon: 'H₁', label: 'Heading 1', description: 'Large section heading' },
  { command: 'h2', icon: 'H₂', label: 'Heading 2', description: 'Section heading' },
  { command: 'h3', icon: 'H₃', label: 'Heading 3', description: 'Small section heading' },
  { command: 'quote', icon: '❞', label: 'Block quote', description: 'Set a quote apart' },
  { command: 'code', icon: '⌘', label: 'Code block', description: 'Insert formatted code' },
  { command: 'mermaid', icon: '⟁', label: 'Diagram', description: 'Mermaid diagram with live preview' },
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
