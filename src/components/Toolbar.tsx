import type { Editor } from '@tiptap/core'
import type { ReactNode } from 'react'
import { Bold, Code, Columns3, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Minus, Plus, Quote, Redo2, Rows3, Table, Trash2, Type, Undo2 } from 'lucide-react'

type Flags = { bold: boolean; italic: boolean; h1: boolean; h2: boolean; h3: boolean; inTable: boolean }
const groups: { action: string; label: ReactNode; title: string; flag?: keyof Flags }[][] = [
  [{ action: 'bold', label: <Bold size={16} />, title: 'Bold', flag: 'bold' }, { action: 'italic', label: <Italic size={16} />, title: 'Italic', flag: 'italic' }],
  [{ action: 'h1', label: <Heading1 size={16} />, title: 'Heading 1', flag: 'h1' }, { action: 'h2', label: <Heading2 size={16} />, title: 'Heading 2', flag: 'h2' }, { action: 'h3', label: <Heading3 size={16} />, title: 'Heading 3', flag: 'h3' }, { action: 'paragraph', label: <Type size={16} />, title: 'Normal text' }],
  [{ action: 'bullet', label: <List size={16} />, title: 'Bullet list' }, { action: 'ordered', label: <ListOrdered size={16} />, title: 'Numbered list' }, { action: 'quote', label: <Quote size={16} />, title: 'Block quote' }, { action: 'code', label: <Code size={16} />, title: 'Code block' }],
  [{ action: 'table', label: <Table size={16} />, title: 'Insert table' }, { action: 'undo', label: <Undo2 size={16} />, title: 'Undo' }, { action: 'redo', label: <Redo2 size={16} />, title: 'Redo' }],
]
const tableActions: { action: string; label: ReactNode; title: string }[] = [
  { action: 'row', label: <><Plus size={12} /><Rows3 size={14} /></>, title: 'Add row' }, { action: 'column', label: <><Plus size={12} /><Columns3 size={14} /></>, title: 'Add column' },
  { action: 'deleteRow', label: <><Minus size={12} /><Rows3 size={14} /></>, title: 'Delete row' }, { action: 'deleteColumn', label: <><Minus size={12} /><Columns3 size={14} /></>, title: 'Delete column' },
  { action: 'header', label: 'Header row', title: 'Toggle header row' }, { action: 'deleteTable', label: <><Trash2 size={13} /> Table</>, title: 'Remove table' },
]

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
            {group.map(item => <button key={item.action} type="button" data-action={item.action} title={item.title} aria-label={item.title} aria-pressed={item.flag ? flags[item.flag] : undefined} className={item.flag && flags[item.flag] ? 'active' : ''} disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => runAction(editor, item.action)}>{item.label}</button>)}
          </span>
        ))}
      </nav>
      {flags.inTable && !disabled && (
        <nav className="table-tools" aria-label="Table">
          <span>Table</span>
          {tableActions.map(item => <button key={item.action} type="button" data-action={item.action} title={item.title} aria-label={item.title} onMouseDown={e => e.preventDefault()} onClick={() => runAction(editor, item.action)}>{item.label}</button>)}
        </nav>
      )}
    </>
  )
}
