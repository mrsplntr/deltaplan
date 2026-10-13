import { expect, test } from 'claude-code/testing'

import { blockKind, layoutMarkdown, parseInline, splitLines, stepUnit, unitRange, unitStart } from '../hooks/markdown'

test('the newline that ends the file adds no line, but a blank line before it stays', () => {
  expect(splitLines('# Plan\nline\n')).toEqual(['# Plan', 'line'])
  expect(splitLines('# Plan\r\nline')).toEqual(['# Plan', 'line'])
  expect(splitLines('line\n\n')).toEqual(['line', ''])
  expect(splitLines('')).toEqual([''])
})

test('inline symbols become styles and disappear from the text', () => {
  expect(parseInline('Use **Redis** for the `cache`, *maybe*')).toEqual([
    { text: 'Use ' },
    { text: 'Redis', bold: true },
    { text: ' for the ' },
    { text: 'cache', code: true },
    { text: ', ' },
    { text: 'maybe', italic: true },
  ])
  expect(parseInline('see [the docs](https://x.y) and snake_case_name')).toEqual([
    { text: 'see ' },
    { text: 'the docs', link: true },
    { text: ' and snake_case_name' },
  ])
  expect(parseInline('2 * 3 and a lone ` tick')).toEqual([{ text: '2 * 3 and a lone ` tick' }])
})

test('headings, list markers as written, numbered items, tasks and quotes', () => {
  const layout = layoutMarkdown(['## Step **one**', '- item', '  * nested', '3. third', '- [x] done', '> note', '', '---'])
  expect(layout[0]).toEqual({ kind: 'heading', level: 2, spans: [{ text: 'Step ' }, { text: 'one', bold: true }] })
  expect(layout[1]).toEqual({ kind: 'item', indent: '', marker: '- ', isQuote: false, spans: [{ text: 'item' }] })
  expect(layout[2]).toEqual({ kind: 'item', indent: '  ', marker: '* ', isQuote: false, spans: [{ text: 'nested' }] })
  expect(layout[3]).toEqual({ kind: 'item', indent: '', marker: '3. ', isQuote: false, spans: [{ text: 'third' }] })
  expect(layout[4]).toEqual({ kind: 'item', indent: '', marker: '- ', isQuote: false, spans: [{ text: '[x] done' }] })
  expect(layout[5]).toEqual({ kind: 'item', indent: '', marker: '│ ', isQuote: true, spans: [{ text: 'note' }] })
  expect(layout[6]).toEqual({ kind: 'blank' })
  expect(layout[7]).toEqual({ kind: 'rule' })
})

test('a code block keeps one display line per file line, spacing intact', () => {
  const layout = layoutMarkdown(['```ts', 'if (x) {', '    return **y**', '}', '```'])
  expect(layout.map(l => l.kind)).toEqual(['fence', 'code', 'code', 'code', 'fence'])
  expect(layout[2]).toEqual({ kind: 'code', text: '    return **y**' })
})

test('a fence inside a longer fence is code, and only a bare fence closes a block', () => {
  const nested = layoutMarkdown(['Intro', '````markdown', '# Readme', '```bash', 'npm i', '```', '````', 'After'])
  expect(nested.map(l => l.kind)).toEqual(['text', 'fence', 'code', 'code', 'code', 'code', 'fence', 'text'])
  expect(nested[3]).toEqual({ kind: 'code', text: '```bash' })

  const sameLength = layoutMarkdown(['```md', 'Example:', '```js', 'code()', '```', 'After'])
  expect(sameLength.map(l => l.kind)).toEqual(['fence', 'code', 'code', 'code', 'fence', 'text'])
})

test('a table gives each row its own line, with shared column widths', () => {
  const layout = layoutMarkdown(['| Name | Role |', '|---|---|', '| **Ann** | dev |', '| Bo | product owner |'])
  expect(layout.map(l => l.kind)).toEqual(['table', 'tableRule', 'table', 'table'])
  expect(layout[0]).toMatchObject({ isHeader: true, widths: [4, 13] })
  expect(layout[2]).toMatchObject({ isHeader: false, cells: [[{ text: 'Ann', bold: true }], [{ text: 'dev' }]] })
})

test('a table is one unit: any row selects the whole table', () => {
  const layout = layoutMarkdown(['Before', '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', 'After'])
  expect(unitRange(layout, 4)).toEqual({ start: 2, end: 5 })
  expect(unitStart(layout, 3)).toBe(2)
  expect(blockKind(layout, 5)).toBe('table')
  expect(blockKind(layout, 1)).toBe(null)
  expect(stepUnit(layout, 1, 1)).toBe(2)
  expect(stepUnit(layout, 2, 1)).toBe(6)
  expect(stepUnit(layout, 6, -1)).toBe(2)
})

test('Mermaid and text drawings are one unit each', () => {
  const lines = [
    'Intro',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '┌─────┐',
    '│ App │',
    '└──┬──┘',
    '   ▼',
    'After',
  ]
  const layout = layoutMarkdown(lines)
  expect(layout.map(l => l.kind)).toEqual([
    'text',
    'diagram',
    'diagram',
    'diagram',
    'diagram',
    'diagram',
    'diagram',
    'diagram',
    'diagram',
    'text',
  ])
  expect(unitRange(layout, 4)).toEqual({ start: 2, end: 5 })
  expect(unitStart(layout, 8)).toBe(6)
  expect(unitRange(layout, 7)).toEqual({ start: 6, end: 9 })
  // ↓ from the intro lands on the Mermaid block, then the drawing, then After.
  expect(stepUnit(layout, 1, 1)).toBe(2)
  expect(stepUnit(layout, 3, 1)).toBe(6)
  expect(stepUnit(layout, 6, 1)).toBe(10)
  expect(stepUnit(layout, 10, -1)).toBe(6)
})

test('a flow written with arrows, or a list of them, is not a drawing', () => {
  const layout = layoutMarkdown([
    'Login → dashboard → settings',
    'Logout → home → login',
    '- step → step → step',
    '- next → next → next',
  ])
  expect(layout.map(l => l.kind)).toEqual(['text', 'text', 'item', 'item'])
})
