import type { Review } from '../types'

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
// in line order, each quoting its line. Never the whole plan.
export function buildFeedback(review: Review): string {
  const lines = Object.keys(review.notes)
    .map(Number)
    .sort((a, b) => a - b)
    .map(n => `Line ${n} "${quote(review.lines[n - 1] ?? '')}": comment — ${review.notes[String(n)]}`)
  return [FEEDBACK_HEADER, ...lines].join('\n')
}

// How many comments a sent feedback text carries, read back from the text.
export function countFeedbackLines(text: string): number {
  return (text.match(/^Line \d+ /gm) ?? []).length
}
