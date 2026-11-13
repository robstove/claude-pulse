# Pulse

Live session metrics for Claude Code. Pulse tracks each session with hooks and shows the figures in a pane beside the chat and on the hint line under the prompt.

<img src="docs/screenshot.png" alt="The Pulse pane in the Claude Code desktop app, with session cost, context gauge, turn time and cost chart, token mix, time per tool, and tokens per model" width="415">

- **Cost and elapsed time** for the session, as the status line counts them.
- **Context** fill as a gauge that turns amber at 60% and red at 80%.
- **Turns**: time and cost per turn on one chart, with a live bar that grows once a second while a turn runs.
- **Tokens**: cache read, cache write, input, and output as one stacked bar.
- **Tools**: total time per tool, with failed calls in red. Calls that other plugins make through the tool chain are counted apart.
- **Models**: turns, average time, and tokens for each model that answered, so a `/model` switch shows its own share.

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

Counts start when the plugin first loads in a session. Cost, elapsed time, and context come from the engine and cover the whole session. The cost per turn starts with the second turn, because it needs a starting cost.

Pulse saves each session's metrics in its plugin store at the end of every turn, so a restart or `claude --resume` reopens the pane with the session's history. It keeps the 50 most recent sessions. `/clear` starts a new session, and the pane starts empty.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
