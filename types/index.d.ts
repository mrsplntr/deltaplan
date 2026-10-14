export type Review = {
  toolUseId: string
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
    'deltaplan': {
      planPath: string | null
      // The versions of the plan in this plan-mode session, oldest first.
      history: string[]
      // True once plan mode has ended: the next plan starts a new session at
      // version 1.
      sessionEnded: boolean
      review: Review | null
    }
  }
}
