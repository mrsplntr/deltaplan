import { expect, test } from 'claude-code/testing'

import type { Review } from '../types'
import { drawPlan } from '../hooks/draw'
import type { Elements } from '../hooks/draw'

// Elements drawn as plain nodes, to read the tree back.
const elements = { Box: 'Box', Button: 'Button', Text: 'Text' } as unknown as Elements
const actions = { onContinue() {}, onFeedback() {}, onSelect() {} }

type Node = { type?: string; props?: { key?: string }; children?: unknown[] }

function find(node: unknown, key: string): Node | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as Node
  if (n.props?.key === key) return n
  for (const child of n.children ?? []) {
    const found = find(child, key)
    if (found) return found
  }
  return undefined
}

function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  return ((node as Node).children ?? []).map(text).join('')
}

// A row's number column: the first of its three columns.
const numberOf = (row: Node | undefined) => text(row?.children?.[0])

function review(previous: string[], lines: string[]): Review {
  return { toolUseId: 't', version: 2, lines, previous, notes: {}, selected: null }
}

test('a removed line shows its number in the previous version', () => {
  const tree = drawPlan(elements, review(['a', 'old', 'b'], ['a', 'b', 'new']), actions)
  expect(numberOf(find(tree, 'removed-1'))).toBe('2')
  expect(numberOf(find(tree, 'text-3'))).toBe('3')
})

test('the number column fits the longer of the two versions', () => {
  const old = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  const tree = drawPlan(elements, review(old, old.slice(0, 9)), actions)
  expect(numberOf(find(tree, 'removed-9'))).toBe('10')
  const column = find(tree, 'text-1')?.children?.[0] as { props?: { width?: number } }
  expect(column.props?.width).toBe(2)
})

test('the header counts every added and removed line', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `new ${i + 1}`)
  const tree = drawPlan(elements, review(['x', 'old 1', 'old 2', 'y'], ['x', ...ten, 'y']), actions)
  expect(text(tree)).toContain('10 added · 2 removed')
})
