// How each line of the plan file is displayed: Markdown symbols dropped and
// turned into styles, one display line per file line, so line numbers,
// comments and the diff stay tied to the file. The file itself is never
// changed.

export type Span = {
  text: string
  bold?: true
  italic?: true
  code?: true
  link?: true
  strike?: true
}

// A run of file lines selected as one unit (a diagram or a table), 1-based
// and inclusive.
export type Block = { start: number; end: number }

export type DisplayLine =
  | { kind: 'blank' }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'text'; spans: Span[] }
  // A list item or quote: leading indentation, the marker ("- " and "1. " as
  // written, "│ " for a quote), then the item.
  | { kind: 'item'; indent: string; marker: string; isQuote: boolean; spans: Span[] }
  | { kind: 'rule' }
  // A fenced code block: its fence lines dim, each code line exactly as typed.
  | { kind: 'fence'; text: string }
  | { kind: 'code'; text: string }
  // A table row with its column widths; the alignment row is drawn as a rule.
  // The block is the whole table.
  | { kind: 'table'; cells: Span[][]; widths: number[]; isHeader: boolean; block: Block }
  | { kind: 'tableRule'; widths: number[]; block: Block }
  // One line of a diagram, exactly as typed; the block is the whole diagram.
  | { kind: 'diagram'; text: string; block: Block }

// Characters a text drawing is made of: box lines, corners and arrows.
const DRAWING = /[─━│┃┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰▲▼◀▶►◄△▽↑↓→←↔↕⇒⇐⇑⇓]/g

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/
const QUOTE = /^(\s*)>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

// A line that closes a fence opened with `mark`: the same character, at least
// as many of them, and nothing after. So "```bash" inside a "````" block, or
// inside a "```" block, is code, as in the approval dialog.
function closesFence(line: string, mark: string): boolean {
  const close = FENCE_CLOSE.exec(line)
  return close !== null && close[1]![0] === mark[0] && close[1]!.length >= mark.length
}

function drawingCount(line: string): number {
  return (line.match(DRAWING) ?? []).length
}

// Box lines and corners alone, without arrows: a drawing outside a fence must
// have some, so a flow written as text ("A → B → C") stays text.
const BOX = /[─━│┃┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰]/

// A line that belongs to a text drawing: two drawing characters, or one that
// makes up a good part of the line.
function isDrawingLine(line: string): boolean {
  const count = drawingCount(line)
  const visible = line.replace(/\s/g, '').length
  return count >= 2 || (count === 1 && visible > 0 && count / visible >= 0.3)
}

function isLooseDrawingLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('|')) return false
  if (HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line)) return false
  return isDrawingLine(line)
}

// A fenced block with no language (or a plain-text one) holding a drawing.
function isDrawingBlock(lines: readonly string[]): boolean {
  const drawn = lines.filter(isDrawingLine).length
  return drawn >= 2 && drawn >= lines.filter(l => l.trim() !== '').length / 2
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (row[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += row[i]
    }
  }
  cells.push(cell.trim())
  return cells
}

export function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + span.text.length, 0)
}

// Inline Markdown to styled spans: `code`, **bold**, *italic*, ~~strike~~,
// [links](url). An unmatched symbol stays as typed.
export function parseInline(source: string): Span[] {
  const out: Span[] = []
  parseInto(source, {}, out)
  // Join neighbours with the same style, so one word is one span.
  const joined: Span[] = []
  for (const span of out) {
    const last = joined.at(-1)
    if (last && sameStyle(last, span)) last.text += span.text
    else joined.push({ ...span })
  }
  return joined
}

type Style = Omit<Span, 'text'>

function sameStyle(a: Span, b: Span): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link && a.strike === b.strike
}

function parseInto(s: string, style: Style, out: Span[]): void {
  let buf = ''
  const flush = () => {
    if (buf !== '') out.push({ ...style, text: buf })
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]!

    if (c === '\\' && i + 1 < s.length && /[\\`*_[\]()#+\-.!|~>]/.test(s[i + 1]!)) {
      buf += s[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      let run = 1
      while (s[i + run] === '`') run++
      const ticks = '`'.repeat(run)
      const end = s.indexOf(ticks, i + run)
      if (end > i + run - 1) {
        let code = s.slice(i + run, end)
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        flush()
        out.push({ ...style, code: true, text: code })
        i = end + run
        continue
      }
      buf += ticks
      i += run
      continue
    }

    if (c === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        parseInto(s.slice(i + 2, end), { ...style, strike: true }, out)
        i = end + 2
        continue
      }
    }

    if ((c === '*' || c === '_') && s[i + 1] === c) {
      const end = s.indexOf(c + c, i + 2)
      if (end > i + 2 && s[i + 2] !== ' ') {
        flush()
        parseInto(s.slice(i + 2, end), { ...style, bold: true }, out)
        i = end + 2
        continue
      }
    }

    if ((c === '*' || c === '_') && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      // An underscore inside a word (snake_case) is not emphasis.
      const opensWord = c === '*' || i === 0 || !/\w/.test(s[i - 1]!)
      let end = opensWord ? s.indexOf(c, i + 1) : -1
      while (end > 0 && (s[end + 1] === c || s[end - 1] === ' ' || (c === '_' && /\w/.test(s[end + 1] ?? '')))) {
        end = s.indexOf(c, end + (s[end + 1] === c ? 2 : 1))
      }
      if (end > i + 1) {
        flush()
        parseInto(s.slice(i + 1, end), { ...style, italic: true }, out)
        i = end + 1
        continue
      }
    }

    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const open = c === '!' ? i + 1 : i
      const close = s.indexOf('](', open + 1)
      const end = close < 0 ? -1 : s.indexOf(')', close + 2)
      if (close > open && end > close) {
        flush()
        parseInto(s.slice(open + 1, close), { ...style, link: true }, out)
        i = end + 1
        continue
      }
    }

    buf += c
    i++
  }
  flush()
}

export function layoutMarkdown(lines: readonly string[]): DisplayLine[] {
  const out: DisplayLine[] = new Array(lines.length)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // A fenced block: a diagram when it is Mermaid or holds a drawing,
    // otherwise code.
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const mark = fence[1]!
      const lang = fence[2]!.toLowerCase()
      let end = i + 1
      while (end < lines.length && !closesFence(lines[end]!, mark)) end++
      const last = Math.min(end, lines.length - 1)
      const inner = lines.slice(i + 1, end)
      const isDiagram =
        lang === 'mermaid' || (['', 'text', 'txt', 'plain', 'ascii'].includes(lang) && isDrawingBlock(inner))
      if (isDiagram) {
        const block = { start: i + 1, end: last + 1 }
        for (let k = i; k <= last; k++) out[k] = { kind: 'diagram', text: lines[k]!, block }
      } else {
        out[i] = { kind: 'fence', text: line }
        for (let k = i + 1; k < end; k++) out[k] = { kind: 'code', text: lines[k]! }
        if (end < lines.length) out[end] = { kind: 'fence', text: lines[end]! }
      }
      i = last + 1
      continue
    }

    // A text drawing outside a fence: two or more drawing lines in a row,
    // with box lines among them, none of them a list item, heading or table.
    if (isLooseDrawingLine(line) && i + 1 < lines.length && isLooseDrawingLine(lines[i + 1]!)) {
      let end = i
      while (end + 1 < lines.length && isLooseDrawingLine(lines[end + 1]!)) end++
      if (lines.slice(i, end + 1).some(l => BOX.test(l))) {
        const block = { start: i + 1, end: end + 1 }
        for (let k = i; k <= end; k++) out[k] = { kind: 'diagram', text: lines[k]!, block }
        i = end + 1
        continue
      }
    }

    // A table: a row of cells followed by the alignment row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      let end = i + 1
      while (end + 1 < lines.length && lines[end + 1]!.includes('|') && lines[end + 1]!.trim() !== '') end++
      const rows = lines.slice(i, end + 1).map((row, k) => (k === 1 ? null : splitRow(row).map(parseInline)))
      const columns = Math.max(...rows.map(r => r?.length ?? 0))
      const widths = Array.from({ length: columns }, (_, c) =>
        Math.max(1, ...rows.map(r => (r?.[c] ? spansWidth(r[c]!) : 0))),
      )
      const block = { start: i + 1, end: end + 1 }
      rows.forEach((cells, k) => {
        out[i + k] =
          cells === null ? { kind: 'tableRule', widths, block } : { kind: 'table', cells, widths, isHeader: k === 0, block }
      })
      i = end + 1
      continue
    }

    out[i] = layoutLine(line)
    i++
  }
  return out
}

function layoutLine(line: string): DisplayLine {
  if (line.trim() === '') return { kind: 'blank' }

  const heading = HEADING.exec(line)
  if (heading) return { kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!) }

  if (RULE.test(line)) return { kind: 'rule' }

  const bullet = BULLET.exec(line)
  if (bullet) {
    return { kind: 'item', indent: bullet[1]!, marker: `${bullet[2]} `, isQuote: false, spans: parseInline(bullet[3]!) }
  }

  const numbered = NUMBERED.exec(line)
  if (numbered) {
    return { kind: 'item', indent: numbered[1]!, marker: `${numbered[2]} `, isQuote: false, spans: parseInline(numbered[3]!) }
  }

  const quote = QUOTE.exec(line)
  if (quote) return { kind: 'item', indent: quote[1]!, marker: '│ ', isQuote: true, spans: parseInline(quote[2]!) }

  return { kind: 'text', spans: parseInline(line) }
}

// What kind of block holds line n, when a block does: a diagram or a table
// is selected and commented on as one unit.
export function blockKind(layout: readonly DisplayLine[], n: number): 'diagram' | 'table' | null {
  const line = layout[n - 1]
  if (line?.kind === 'diagram') return 'diagram'
  if (line?.kind === 'table' || line?.kind === 'tableRule') return 'table'
  return null
}

// The lines a comment on unit n covers: the whole block, or n alone.
export function unitRange(layout: readonly DisplayLine[], n: number): Block {
  const line = layout[n - 1]
  return line !== undefined && 'block' in line ? line.block : { start: n, end: n }
}

// The 1-based line a comment on line n attaches to: its block's first line,
// or n itself.
export function unitStart(layout: readonly DisplayLine[], n: number): number {
  return unitRange(layout, n).start
}

// The unit before or after the one holding line n, for ↑ and ↓.
export function stepUnit(layout: readonly DisplayLine[], n: number | null, delta: number): number {
  const count = layout.length
  if (count === 0) return 1
  if (n === null) return delta > 0 ? 1 : unitStart(layout, count)
  const range = unitRange(layout, n)
  if (delta > 0) return range.end >= count ? unitStart(layout, n) : range.end + 1
  return range.start <= 1 ? 1 : unitStart(layout, range.start - 1)
}
