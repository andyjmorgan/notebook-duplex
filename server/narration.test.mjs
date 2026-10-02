import test from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, imageText, tableIntro, columnTitles, tableRowText, describeDiagramFallback, describeCodeFallback, diagramUtterance, codeUtterance, spokenText, diagramNodes } from '../shared/narration.mjs'

test('sentences split on terminators and keep offsets into the source', () => {
  const text = 'First sentence here.  Second one follows! Does a third?'
  const parts = splitSentences(text)
  assert.deepEqual(parts.map(p => p.text), ['First sentence here.', 'Second one follows!', 'Does a third?'])
  for (const p of parts) assert.equal(text.slice(p.start, p.end), p.text)
})
test('abbreviations, initials and decimals do not end a sentence', () => {
  assert.deepEqual(splitSentences('Dr. Who met Mr. T at 3.5 p.m. on Tuesday. Then J. R. R. Tolkien arrived, e.g. late.').map(p => p.text), ['Dr. Who met Mr. T at 3.5 p.m. on Tuesday.', 'Then J. R. R. Tolkien arrived, e.g. late.'])
  assert.deepEqual(splitSentences('Bring pens, paper, etc. and sit down. Buy pens, etc. Then leave.').map(p => p.text), ['Bring pens, paper, etc. and sit down.', 'Buy pens, etc.', 'Then leave.'])
})
test('very short fragments merge into the following sentence and quotes stay attached', () => {
  assert.deepEqual(splitSentences('Yes. We shipped it on time. He said "done." Then left.').map(p => p.text), ['Yes. We shipped it on time.', 'He said "done."', 'Then left.'])
  assert.deepEqual(splitSentences('   '), [])
  assert.deepEqual(splitSentences('No terminator at all').map(p => p.text), ['No terminator at all'])
})
test('images, tables and code blocks have fixed spoken forms', () => {
  assert.equal(imageText('a red fox'), 'An image of a red fox')
  assert.equal(imageText(''), 'An image')
  assert.equal(imageText(' fox ', true), 'an image of fox')
  assert.equal(tableIntro(3, 2), 'A table with 3 columns and 2 rows.')
  assert.equal(tableIntro(1, 1), 'A table with 1 column and 1 row.')
  assert.deepEqual(columnTitles(['Idea', ''], 3), ['Idea', 'Column 2', 'Column 3'])
  assert.deepEqual(columnTitles(null, 2), ['Column 1', 'Column 2'])
  assert.equal(tableRowText(['Idea', 'Next step'], ['Write freely', 'Let the agent work in the margin.']), 'Idea: Write freely. Next step: Let the agent work in the margin.')
  assert.equal(tableRowText(['Column 1'], ['']), 'Column 1: blank.')
  assert.equal(describeCodeFallback('python', 'import os\n\nprint(os.getcwd())\n'), 'A Python code block with 2 lines.')
  assert.equal(describeCodeFallback(null, 'x'), 'A code block with 1 line.')
})
test('diagram fallback names the kind and lists nodes deterministically', () => {
  assert.equal(describeDiagramFallback('flowchart LR\n  A[Write] --> B[Review] --> C[Ship]\n  C -->|feedback| D'), 'a flowchart with 4 nodes: Write, Review, Ship, D.')
  assert.equal(describeDiagramFallback('---\nconfig:\n  theme: forest\n---\ngraph TD\n  A --> B\n  B --> C\n  C --> D'), 'a flowchart with 4 nodes: A, B, C, D.')
  assert.deepEqual(diagramNodes('mindmap\n  root((Notebook))\n    Writer\n    Claude'), ['Notebook', 'Writer', 'Claude'])
  assert.equal(describeDiagramFallback('sequenceDiagram\n  participant W as Writer\n  W->>C: asks\n  C-->>W: answers'), 'a sequence diagram with 2 participants: Writer, C.')
  assert.equal(describeDiagramFallback('pie title Pets\n  "Dogs" : 40\n  "Cats" : 60'), 'a pie chart with 2 slices: Dogs, Cats.')
  assert.equal(describeDiagramFallback('gantt\n  title X'), 'a Gantt chart.')
})
test('utterances compose intros with model output and strip markdown', () => {
  assert.equal(diagramUtterance('a three-step flow from writing to shipping'), 'A chart or diagram showing a three-step flow from writing to shipping.')
  assert.equal(diagramUtterance('This diagram shows A linear pipeline.'), 'A chart or diagram showing a linear pipeline.')
  assert.equal(diagramUtterance(''), 'A chart or diagram.')
  assert.equal(codeUtterance('bash', 'it lists files then exits'), 'A shell code block. It lists files then exits.')
  assert.equal(codeUtterance('json', ''), 'A JSON code block.')
  assert.equal(spokenText('**Bold** and `code`\n\n- item one\n```js\nx\n```'), 'Bold and code item one')
})
