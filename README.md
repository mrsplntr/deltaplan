# DeltaPlan

**Comment on Claude's plan line by line. See what changed as a diff.**

In plan mode, giving feedback means copying lines from the plan and explaining what to change. After Claude revises, you can't tell what actually changed.

DeltaPlan fixes both:

- **Comment on any line.** Pick a line, type a comment. Send feedback, and Claude gets each comment with the line it's about.
- **See what changed.** Every revision shows like a git diff: green for added lines, red for removed.
- **You stay in control.** DeltaPlan never approves a plan. Continue opens Claude Code's normal approval dialog.
- **Local only.** No browser, no network, no extra model calls.

## Examples

- **Point at the exact line.** Instead of copying lines into a message and explaining where they are, click a line and type your comment. Claude gets each comment with the line it's about.
- **Check that your fixes landed.** After Send feedback, version 2 shows a diff. Check only the red and green lines, instead of rereading the whole plan to find what changed.
- **Catch changes you didn't ask for.** If Claude quietly rewrote a step you were happy with, it shows up in the diff too.

## Install

Pick one way only:

- **Marketplace** (below): one command. Updates when you ask, or by itself once you turn on auto-update.
- **Manual** (below): clone and load the folder. Update with `git pull`.
- **Anthropic's directory** (coming soon): the only way that updates by itself, with nothing to turn on.

### From the marketplace

In Claude Code (2.1.275 or later), run:

```
/plugin install deltaplan --marketplace mrsplntr/deltaplan
```

To get new versions automatically, run `/plugin`, open **Marketplaces**, select `mrsplntr` and choose **Enable auto-update**. Otherwise, update with `claude plugin update deltaplan@mrsplntr`.

### Manually

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

## Troubleshooting

- **The normal plan dialog shows, without DeltaPlan:** run `/plugin` and check for `mods active · deltaplan`. Mods need Claude Code 2.1.287 or later. DeltaPlan is tested in the terminal.
- **A red message starting with "Error:":** something failed, for example DeltaPlan couldn't read the plan file. The message says what. Claude Code's normal plan dialog opens instead, so you can still approve or refuse the plan.
- **On Windows without Git, buttons take up to a second to respond:** DeltaPlan then waits with `ping` instead of Git's `sleep`.

## Support

Report problems at https://github.com/mrsplntr/deltaplan/issues.

## What it runs

A mod runs with your permissions, so here is everything DeltaPlan does outside Claude Code:

- **Sends nothing.** No network calls. Your comments reach Claude only when you press Send feedback, as the normal plan-refusal message.
- **Reads one file:** the plan file Claude writes in plan mode. It writes no files; plan versions stay in memory.
- **Runs a wait timer.** A mod has no other way to wait for a button press, so while a plan waits it runs, again and again, one of these. Nothing from the plan or your comments is passed to them.
  - macOS and Linux: `sleep 0.4`
  - Windows: `%ProgramFiles%\Git\usr\bin\sleep.exe 0.4`, or `%SystemRoot%\System32\PING.EXE -n 2 127.0.0.1` if that fails

Its hooks:

- Holds Claude's plan (`ExitPlanMode`) until you choose: Send feedback refuses it with your comments; Continue passes it to Claude Code's normal approval dialog. It never approves a plan.
- Watches the messages you send (`UserPromptSubmit`), reading only the permission mode, to tell when plan mode ends. It changes nothing.
- Draws the plan, the comment bar and the spinner text.
- Makes ↑/↓ in the comment field move between plan lines (`ui.focus`).

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