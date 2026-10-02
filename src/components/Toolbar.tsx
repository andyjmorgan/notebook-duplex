import type { Editor } from '@tiptap/core'
type Flags = { bold: boolean; italic: boolean; h1: boolean; h2: boolean; h3: boolean; inTable: boolean }
const groups: { action: string; label: string; title: string; flag?: keyof Flags }[][] = [
  [{ action: 'bold', label: 'B', title: 'Bold', flag: 'bold' }, { action: 'italic', label: 'I', title: 'Italic', flag: 'italic' }],
  [{ action: 'h1', label: 'H1', title: 'Heading 1', flag: 'h1' }, { action: 'h2', label: 'H2', title: 'Heading 2', flag: 'h2' }, { action: 'h3', label: 'H3', title: 'Heading 3', flag: 'h3' }, { action: 'paragraph', label: 'Text', title: 'Normal text' }],
  [{ action: 'bullet', label: '• List', title: 'Bullet list' }, { action: 'ordered', label: '1. List', title: 'Numbered list' }, { action: 'quote', label: 'Quote', title: 'Block quote' }, { action: 'code', label: 'Code', title: 'Code block' }],
  [{ action: 'table', label: '＋ Table', title: 'Insert table' }, { action: 'undo', label: '↶', title: 'Undo' }, { action: 'redo', label: '↷', title: 'Redo' }],
]
const tableActions = [{ action: 'row', label: '＋ Row' }, { action: 'column', label: '＋ Column' }, { action: 'deleteRow', label: '− Row' }, { action: 'deleteColumn', label: '− Column' }, { action: 'header', label: 'Header row' }, { action: 'deleteTable', label: 'Remove table' }]

export function runAction(editor: Editor, action: string) {
  const chain = editor.chain().focus()
  switch (action) {
    case 'bold': return chain.toggleBold().run()
    case 'italic': return chain.toggleItalic().run()
    case 'h1': return chain.toggleHeading({ level: 1 }).run()
    case 'h2': return chain.toggleHeading({ level: 2 }).run()
    case 'h3': return chain.toggleHeading({ level: 3 }).run()
    case 'paragraph': return chain.setParagraph().run()
    case 'bullet': return chain.toggleBulletList().run()
    case 'ordered': return chain.toggleOrderedList().run()
    case 'quote': return chain.toggleBlockquote().run()
    case 'code': return chain.toggleCodeBlock().run()
    case 'table': return chain.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()
    case 'row': return chain.addRowAfter().run()
    case 'column': return chain.addColumnAfter().run()
    case 'deleteRow': return chain.deleteRow().run()
    case 'deleteColumn': return chain.deleteColumn().run()
    case 'header': return chain.toggleHeaderRow().run()
    case 'deleteTable': return chain.deleteTable().run()
    case 'undo': return chain.undo().run()
    case 'redo': return chain.redo().run()
  }
}

export function Toolbar({ editor, flags, disabled }: { editor: Editor; flags: Flags; disabled: boolean }) {
  return (
    <>
      <nav className="toolbar" aria-label="Formatting">
        {groups.map((group, g) => (
          <span className="toolbar-group" key={g}>
            {group.map(item => <button key={item.action} type="button" data-action={item.action} title={item.title} aria-pressed={item.flag ? flags[item.flag] : undefined} className={item.flag && flags[item.flag] ? 'active' : ''} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => runAction(editor, item.action)}>{item.label}</button>)}
          </span>
        ))}
      </nav>
      {flags.inTable && !disabled && (
        <nav className="table-tools" aria-label="Table">
          <span>Table</span>
          {tableActions.map(item => <button key={item.action} type="button" data-action={item.action} onMouseDown={e => e.preventDefault()} onClick={() => runAction(editor, item.action)}>{item.label}</button>)}
        </nav>
      )}
    </>
  )
}
