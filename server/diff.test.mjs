import test from 'node:test'
import assert from 'node:assert/strict'
import { diffWords } from '../shared/diff.mjs'
test('diff reproduces both sides and isolates the changed words', () => {
  const before = 'The quick brown fox jumps over the lazy dog.'
  const after = 'The quick red fox leaps over the lazy dog.'
  const segments = diffWords(before, after)
  assert.equal(segments.filter(s => s.type !== 'ins').map(s => s.text).join(''), before)
  assert.equal(segments.filter(s => s.type !== 'del').map(s => s.text).join(''), after)
  assert.deepEqual(segments.filter(s => s.type === 'del').map(s => s.text.trim()), ['brown', 'jumps'])
  assert.deepEqual(segments.filter(s => s.type === 'ins').map(s => s.text.trim()), ['red', 'leaps'])
})
test('diff handles empty sides', () => {
  assert.deepEqual(diffWords('', 'New'), [{ type: 'ins', text: 'New' }])
  assert.deepEqual(diffWords('Old', ''), [{ type: 'del', text: 'Old' }])
})
