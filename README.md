# Herdr Pi Split

Branch a conversation without leaving it. In Pi, type `/split`. A new pane opens beside the current one in the [Herdr desktop app](https://github.com/herdrdev/herdr-app) and continues the same conversation from the point you pick. Main keeps going; the split goes its own way.

A split is not a watcher. It doesn't follow Main and can't message it. Use it when you want a parallel line of thought, such as trying another approach or asking a side question, without polluting Main.

## Install

Requires [Pi](https://github.com/earendil-works/pi) 1.4+ running inside a Herdr pane, with `hc` and `herdr-app` on your PATH.

```sh
pi install git:github.com/johnlindquist/herdr-pi-split
```

Then run `/reload` in Pi. To remove it: `pi remove git:github.com/johnlindquist/herdr-pi-split`.

Try it once without installing: `pi -e git:github.com/johnlindquist/herdr-pi-split`.

## Use

Type `/split` and a space: Pi lists examples. Use **↑/↓** and **Tab** to insert one, then edit it. Dim text beside the cursor tells you what you can type next; it never becomes part of the command. `/split --help` shows the whole guide without opening a pane, even outside Herdr.

| Type | What happens |
|---|---|
| `/split` | Pick where to branch (it starts on your latest message), press **Enter**. The new pane opens on the right with everything up to that point. |
| `/split "Test fixes"` | Same, and names the split. |
| `/split Investigate the failing tests` | Writes a short handoff summary for that focus, so the split starts lean. The full history stays in its session tree. |
| `/split "Test fixes" Investigate the failing tests` | Name and focus together. |
| `/split --help` | The guide, with these examples. |
| **Shift+Enter** in the picker | Split there and ask for a handoff focus. |
| **ctrl+shift+alt+f** | Shortcut for `/split`. |

Without a name, the split is titled from your latest request on that branch.

## How it works

- **Fork:** the session up to the chosen entry is copied into a new session file (its header links back to the parent). Tool calls left unanswered at the split point get a "not executed in this split" result in the copy only; your live session is never changed.
- **Pane:** `/split` finds the Herdr pane running this Pi and asks Herdr to split it to the right, starting `pi --session <new file>` in the same working directory. If it can't find the pane, it tells you instead of guessing another one.
- **Handoff and title:** made with your current model. If no model is available, the split still opens with the full history and asks you to `/name` it.

Set `HERDR_SPLIT_LAUNCHER` to start a different command than `pi`.

## Tested

In a real Pi 1.5.0 terminal: typing `/split` showed its usage hint, a space listed the five examples, **↓ Tab** inserted `"Test fixes"` with the hint `[optional handoff focus]`, and `/split --help` printed the guide. In an isolated Herdr 0.1.12 + Pi 1.5.0: `/split` + **Enter** opened a second Pi pane to the right, on a new session whose header links to the parent, with the conversation up to the chosen reply.

Unit tests:

```sh
bun test
```

## License

MIT
