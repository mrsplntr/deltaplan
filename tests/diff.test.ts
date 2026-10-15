import { expect, test } from 'claude-code/testing'

import { describeCounts, diffLines } from '../hooks/diff'

test('identical versions have no changes', () => {
  const { rows, counts } = diffLines(['a', 'b'], ['a', 'b'])
  expect(counts).toEqual({ added: 0, removed: 0 })
  expect(rows.map(r => r.kind)).toEqual(['same', 'same'])
})

test('a replaced line counts as one removed and one added, shown old (red) then new (green)', () => {
  const { rows, counts } = diffLines(
    ['# Plan', 'Use Redis for the cache', 'Ship'],
    ['# Plan', 'Use PostgreSQL for the cache', 'Ship'],
  )
  expect(counts).toEqual({ added: 1, removed: 1 })
  expect(rows).toEqual([
    { kind: 'same', line: 1, text: '# Plan' },
    { kind: 'removed', line: 2, from: 2, text: 'Use Redis for the cache' },
    { kind: 'added', line: 2, text: 'Use PostgreSQL for the cache' },
    { kind: 'same', line: 3, text: 'Ship' },
  ])
})

test('pure additions and removals are counted', () => {
  const { rows, counts } = diffLines(['a', 'b', 'c', 'old'], ['a', 'new', 'b', 'c'])
  expect(counts).toEqual({ added: 1, removed: 1 })
  expect(rows).toEqual([
    { kind: 'same', line: 1, text: 'a' },
    { kind: 'added', line: 2, text: 'new' },
    { kind: 'same', line: 3, text: 'b' },
    { kind: 'same', line: 4, text: 'c' },
    { kind: 'removed', line: 5, from: 4, text: 'old' },
  ])
  expect(describeCounts(counts)).toBe('1 added · 1 removed')
})

test('a change of formatting alone still counts', () => {
  const { counts } = diffLines(['- Use Redis'], ['- Use **Redis**'])
  expect(counts).toEqual({ added: 1, removed: 1 })
})

test('a longer replacement counts every line it removes and adds', () => {
  const { counts } = diffLines(['x', 'one', 'y'], ['x', 'two', 'three', 'y'])
  expect(counts).toEqual({ added: 2, removed: 1 })
})

test('2 lines replaced by 10 count as 10 added and 2 removed', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `new ${i + 1}`)
  const { counts } = diffLines(['x', 'old 1', 'old 2', 'y'], ['x', ...ten, 'y'])
  expect(counts).toEqual({ added: 10, removed: 2 })
  expect(describeCounts(counts)).toBe('10 added · 2 removed')
})

