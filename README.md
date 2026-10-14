# DeltaPlan

**Comment on Claude's plan line by line. See what changed as a diff.**

In plan mode, giving feedback means copying lines from the plan and explaining what to change. After Claude revises, you can't tell what actually changed.

DeltaPlan fixes both:

- **Comment on any line.** Pick a line, type a comment. Send feedback, and Claude gets each comment with the line it's about.
- **See what changed.** Every revision shows like a git diff: green for added lines, red for removed.
- **You stay in control.** DeltaPlan never approves a plan. Continue opens Claude Code's normal approval dialog.
- **Local only.** No browser, no network, no extra model calls.

## Install

```
git clone https://github.com/mrsplntr/deltaplan
```

Then start Claude Code in your project with the mod loaded (add this each time):

```
claude --plugin-dir /path/to/deltaplan
```

Or, to load it in every session without the flag, add it to `~/.claude/settings.json`. Put `env` at the top level of the file, next to your other settings, and use the full path:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/deltaplan"
  }
}
```

If the file already has an `env` section, add the line inside it.

## Use

1. Ask for a plan in plan mode (Shift+Tab).
2. Click a line and type a comment in the DeltaPlan comment field. Enter saves it.
3. Press **Send feedback** to get a revised plan, or **Continue to approval** when it's ready.

## What it runs

A mod runs with your permissions, so here is everything DeltaPlan does outside Claude Code:

- Reads the plan file. Writes no files and sends nothing over the network.
- Runs `sleep` (on Windows, `sleep.exe` or `PING.EXE`) as a timer while it waits for your choice, since a mod has no other way to wait that long.

## Requirements

- Claude Code with mod support (built and tested with 2.1.296).
- Tested in the terminal.

## Development

The type-check needs Node.js, and the type files Claude Code adds when it first loads the mod, so run `claude --plugin-dir .` once before it.

```
npx -y -p typescript@5.6.3 tsc -p .   # type-check
claude plugin validate .              # check the manifest and hooks
claude plugin test .                  # run the tests
```

## License

[MIT](LICENSE)