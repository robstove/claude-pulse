# Pulse

Live session metrics for Claude Code. Pulse tracks each session with hooks and shows the figures in a pane beside the chat and on the hint line under the prompt.

- **Cost and elapsed time** for the session, as the status line counts them.
- **Context** fill as a gauge that turns amber at 60% and red at 80%.
- **Turns**: time and cost per turn on one chart, with a live bar that grows once a second while a turn runs.
- **Tokens**: cache read, cache write, input, and output as one stacked bar.
- **Tools**: total time per tool, with failed calls in red. Calls that other plugins make through the tool chain are counted apart.

On desktop, VS Code, and mobile the charts are SVG with hover tooltips. The terminal gets block-character bars and sparklines.

## Install

At the prompt of a terminal session:

```
/plugin install pulse --marketplace robstove/claude-pulse
```

From a shell:

```bash
claude plugin install pulse --marketplace robstove/claude-pulse
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `robstove/claude-pulse`, then Add plugin.

This repository is private. It installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Use

The pane opens when a session starts. If you close it, `/pulse` opens it again.

Counts start when the plugin loads. Cost, elapsed time, and context come from the engine and cover the whole session. The cost per turn starts with the second turn after a load, because it needs a starting cost.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
