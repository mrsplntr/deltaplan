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

test('a removed line shows no number, and nothing to click', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const tree = drawPlan(elements, review(['a', 'old', 'b'], ['a', 'b', 'new']), actions, surface)
    expect(numberOf(find(tree, 'removed-1'))).toBe('')
    const numberColumn = find(tree, 'removed-1')?.children?.[0] as Node
    expect((numberColumn.children?.[0] as Node).type).toBe('Text')
    expect(numberOf(find(tree, 'text-3'))).toBe('3')
  }
})

test('the header counts every added and removed line', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `new ${i + 1}`)
  const tree = drawPlan(elements, review(['x', 'old 1', 'old 2', 'y'], ['x', ...ten, 'y']), actions, 'terminal')
  expect(text(tree)).toContain('10 added · 2 removed')
})

// A plan whose line 2 is new, as each surface draws it.
const twoLines = (surface: 'terminal' | 'desktop') => {
  const selected: number[] = []
  const tree = drawPlan(elements, review(['a'], ['a', 'a new line']), { ...actions, onSelect: n => selected.push(n) }, surface)
  return { tree, selected }
}

const isButton = (node: Node | undefined) => node?.type === 'Button'

test('in the terminal, both the line and its number select it', () => {
  const { tree } = twoLines('terminal')
  expect(isButton(find(tree, 'line-2'))).toBe(true)
  expect(isButton(find(tree, 'number-2'))).toBe(true)
})

test('on the desktop, the number selects and the text stays plain, colored text', () => {
  const { tree } = twoLines('desktop')
  expect(find(tree, 'line-2')).toBeUndefined()
  expect(isButton(find(tree, 'number-2'))).toBe(true)
  // The text column holds Text, not a Button, so it wraps and keeps its green.
  const textColumn = find(tree, 'text-2')?.children?.[2] as Node
  const shown = textColumn.children?.[0] as Node
  expect(shown.type).toBe('Text')
  expect(text(shown)).toBe('a new line')
  expect(JSON.stringify(shown)).toContain('"color":"success"')
})

test('on the desktop, the selected line is highlighted', () => {
  const plan = { ...review(['a'], ['a', 'a new line']), selected: 2 }
  const tree = drawPlan(elements, plan, actions, 'desktop')
  const shown = (find(tree, 'text-2')?.children?.[2] as Node).children?.[0] as Node
  // Plain Text, which the desktop draws with its highlight, not inside a native button.
  expect(shown.type).toBe('Text')
  expect(JSON.stringify(shown)).toContain('"inverse":true')
})
