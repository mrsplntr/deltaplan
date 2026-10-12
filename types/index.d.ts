export type Review = {
  toolUseId: string
  path: string
  version: number
  lines: string[]
  // The version before this one, for the diff; null for version 1.
  previous: string[] | null
  // Comments by 1-based line number.
  notes: Record<string, string>
  selected: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'plan-abc': {
      planPath: string | null
      // The versions of the plan under review, oldest first. A new plan
      // request starts it over; a revision after Send feedback adds to it.
      history: string[]
      revisionPending: boolean
      review: Review | null
    }
  }
}
