import { expect, test } from 'claude-code/testing'

import { describeCounts, diffLines } from '../hooks/diff'

test('identical versions have no changes', () => {
  const { rows, counts } = diffLines(['a', 'b'], ['a', 'b'])
  expect(counts).toEqual({ changed: 0, added: 0, removed: 0 })
  expect(rows.map(r => r.kind)).toEqual(['same', 'same'])
})

test('a replaced line is one change, shown old (red) then new (green)', () => {
  const { rows, counts } = diffLines(
    ['# Plan', 'Use Redis for the cache', 'Ship'],
    ['# Plan', 'Use PostgreSQL for the cache', 'Ship'],
  )
  expect(counts).toEqual({ changed: 1, added: 0, removed: 0 })
  expect(rows).toEqual([
    { kind: 'same', line: 1, text: '# Plan' },
    { kind: 'removed', line: 2, from: 2, text: 'Use Redis for the cache', isChange: true },
    { kind: 'added', line: 2, text: 'Use PostgreSQL for the cache', isChange: true },
    { kind: 'same', line: 3, text: 'Ship' },
  ])
})

test('pure additions and removals are counted apart from changes', () => {
  const { rows, counts } = diffLines(['a', 'b', 'c', 'old'], ['a', 'new', 'b', 'c'])
  expect(counts).toEqual({ changed: 0, added: 1, removed: 1 })
  expect(rows).toEqual([
    { kind: 'same', line: 1, text: 'a' },
    { kind: 'added', line: 2, text: 'new', isChange: false },
    { kind: 'same', line: 3, text: 'b' },
    { kind: 'same', line: 4, text: 'c' },
    { kind: 'removed', line: 5, from: 4, text: 'old', isChange: false },
  ])
  expect(describeCounts(counts)).toBe('0 changed · 1 added · 1 removed')
})

test('a change of formatting alone still counts as a change', () => {
  const { counts } = diffLines(['- Use Redis'], ['- Use **Redis**'])
  expect(counts).toEqual({ changed: 1, added: 0, removed: 0 })
})

test('a longer replacement pairs as many lines as it can', () => {
  const { counts } = diffLines(['x', 'one', 'y'], ['x', 'two', 'three', 'y'])
  expect(counts).toEqual({ changed: 1, added: 1, removed: 0 })
})

