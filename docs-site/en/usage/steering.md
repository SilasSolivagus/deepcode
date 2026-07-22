---
title: Steering / rewind / compact
---
# Steering / rewind / compact

While a turn is running, deepcode gives you three kinds of session-level control: interjecting mid-run (steering), rolling the workspace and/or conversation back to an earlier turn (`/rewind`), and compressing context to free up room (`/compact`). This page covers all three.

## Steering

deepcode accepts input while it's generating or executing — you don't have to wait for it to finish before typing. Type your message and hit `Enter`; it's pushed onto a FIFO queue immediately, and when it gets injected depends on what's happening at that moment:

- **Pressing `Enter` while a tool is running**: enqueuing also soft-interrupts the current turn. The tool that's already executing is **not killed** — it finishes normally. Once its result comes back, deepcode drains the queue and injects the queued message(s) as new user messages, then continues into a fresh turn so the model can adjust its next move. Any partial text already generated and any tool results already obtained are preserved — nothing is lost because you interjected.
- **Pressing `Enter` while the model is only streaming plain text with no tool running**: the message is still queued but nothing is interrupted; once the model's current turn finishes naturally (no further tool calls), the queued message is drained and the run continues.

Each queued message is wrapped with a marker that tells the model this was sent by the user while it was still working, so it should adjust the ongoing work rather than treat it as a brand-new, unrelated request.

## `/rewind`: roll back to before a turn

`/rewind` rolls the current session back to the state at the start of a given turn, with three possible scopes:

- **conversation only** — truncates the conversation history, leaves workspace files untouched;
- **code only** — restores files, keeps the conversation history;
- **both** — rolls back conversation and files together.

File restoration works via content-addressed snapshots: before every Edit/Write, deepcode records the target file's contents at that point (or the fact that it didn't exist yet) keyed by turn, with file contents stored as hash-addressed blobs and a separate index. When you rewind to a given turn, for each file it looks up the closest recorded state at or after that turn and writes it back; if the file didn't exist yet at that turn, anything created afterward is deleted. Once the number of recorded entries passes a cap, the oldest ones are evicted FIFO-style, so storage doesn't grow without bound.

If the turn you're rewinding to has already been summarized away by `/compact` and isn't in current memory anymore, `/rewind` tells you plainly that it can't roll the conversation back — it won't pretend to succeed.

## `/compact`: compress context to free up room

Run `/compact` manually to summarize the conversation history into a summary plus the recent tail, replacing the verbose middle section and freeing up context room. The compression itself is protected two ways: a timeout (if it runs too long without a response it's cut off rather than hanging forever), and `Esc`, which can interrupt an in-flight compaction directly. A failed compaction never corrupts the current state — history is only replaced once a new result actually comes back; on failure it's left as-is.

deepcode also triggers this same compression automatically as context approaches its limit; `/compact` is just the manual, on-demand version.

## `Esc`: interrupting the current turn

`Esc` is a hard interrupt, distinct from steering's soft interrupt: pressing it terminates the turn that's currently generating or executing outright. Any pending permission prompt, follow-up question, or plan-approval prompt is resolved as declined so nothing deadlocks, and an in-flight `/compact` is aborted along with it. Pressing `Esc` while idle just clears the input box. Pressing `Esc` twice in a row opens the rewind picker so you can pick a turn to roll back to directly.

## `/clear` and `/fork`

- `/clear` — clears the current conversation and starts a brand-new session file (cumulative session cost is still tracked).
- `/fork` — branches the current conversation into a new session that continues from here; the original session is frozen at the fork point, and the new session's title marks it as a branch.

---

Related: [Commands & keybindings](/en/usage/commands)
