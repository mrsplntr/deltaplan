import type { Review } from '../types'
import { blockKind, layoutMarkdown, unitRange } from './markdown'

const QUOTE_MAX = 120

export const FEEDBACK_HEADER = 'The user reviewed the plan in Plan ABC. Revise the plan and submit it again.'

function quote(line: string): string {
  const text = line.trim()
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text
}

export function noteCount(review: Review): number {
  return Object.keys(review.notes).length
}

// The message Claude reads when the user sends feedback: the notes only,
// in line order, each quoting its line as written in the plan file, Markdown
// symbols included. A comment on a diagram or table names its whole range
// and quotes its first line. Never the whole plan.
export function buildFeedback(review: Review): string {
  const layout = layoutMarkdown(review.lines)
  const lines = Object.keys(review.notes)
    .map(Number)
    .sort((a, b) => a - b)
    .map(n => {
      const { start, end } = unitRange(layout, n)
      const where = end > start ? `Lines ${start}-${end} (${blockKind(layout, n) ?? 'block'})` : `Line ${n}`
      return `${where} "${quote(review.lines[start - 1] ?? '')}": comment — ${review.notes[String(n)]}`
    })
  return [FEEDBACK_HEADER, ...lines].join('\n')
}

// How many comments a sent feedback text carries, read back from the text.
export function countFeedbackLines(text: string): number {
  return (text.match(/^Lines? \d+/gm) ?? []).length
}
