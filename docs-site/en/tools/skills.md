---
title: Skills
---

# Skills

## What skills are

A skill is a packaged instruction set: a directory containing a `SKILL.md` that captures a reusable workflow, piece of domain knowledge, or fixed procedure, so the model can just carry it out in the right situation instead of you re-describing it every time. A skill has two parts: frontmatter (YAML metadata describing what the skill is, when to use it, and how to run it) and a body (the actual instruction text handed to the model).

Skills can be triggered two ways: the model decides for itself, based on the frontmatter `description`, whether the current situation matches a skill and invokes it on its own; or you can trigger a skill directly, bypassing that judgment.

## Source directories

deepcode discovers skills from two directories:

- Global: `~/.deepcode/skills/` — applies to every project
- Project: `<project root>/.deepcode/skills/` — applies only to the current project, and takes priority over the global one (a same-named skill in the project directory overrides the global one)

Each skill is a subdirectory containing a `SKILL.md` file. deepcode also supports a common third-party skills directory for compatibility.

## Writing a skill

`SKILL.md` consists of frontmatter and a body. All frontmatter fields are optional and fall back to a default:

- `name`: the skill's name; defaults to the directory name.
- `description`: the description shown to the model, which decides whether the model can discover and invoke this skill on its own; defaults to the first non-empty line of the body.
- `when-to-use`: extra "when to use this" guidance, shown alongside the description in the listing.
- `context`: `inline` (default) or `fork`. `inline` injects the body as a user message into the current conversation, run directly by the main model; `fork` spawns a separate subagent to run the body, isolated from the current conversation.
- `agent`: when `context: fork`, which agent type runs the subagent; defaults to `general-purpose` if unset.
- `allowed-tools`: when `context: fork`, narrows the tool set available to the subagent (comma-separated or an array).
- `model`: when `context: fork`, the model the subagent uses (a capability-tier alias, or a specific model id).
- `user-invocable`: whether the skill can be triggered directly by hand; defaults to `true`.
- `disable-model-invocation`: when `true`, the model won't discover/invoke this skill on its own — it can only be triggered by hand; defaults to `false`.
- `arguments`: a list of named arguments (comma-separated or an array), used together with named placeholders in the body.

The body supports these substitution variables:

- `$ARGUMENTS`: the full argument string passed at invocation
- `$ARG1`, `$ARG2`, …: the Nth whitespace-separated segment of the arguments
- `$<name>`: a named argument declared in `arguments`, matched by position in declaration order
- `${DEEPCODE_SKILL_DIR}`: the absolute path of the skill's own directory
- `${DEEPCODE_SESSION_ID}`: the current session id

A minimal example (`~/.deepcode/skills/translate/SKILL.md`):

```markdown
---
name: translate
description: Translate a piece of text into a given language
arguments: text, lang
---

Translate the following text into $lang. Return only the translation, no extra commentary:

$text
```

## Triggering

Model-invocable skills (those without `disable-model-invocation: true`, and not narrowed to non-model-invocable) show up in the built-in Skill tool's listing; the model checks whether the current need matches a description and invokes it if so. You can also just tell the model to use a given skill, and it invokes it explicitly the same way.

`user-invocable` skills (all of them, by default) can also be triggered directly by typing `/skill-name args` in the input box, bypassing the model's judgment entirely — the arguments are substituted straight into the body and it runs.

## Narrowing

The `skills` field in `settings.json` controls scan scope:

- `skills.sources`: restricts which directory families get scanned; both are scanned by default. Restricting to only the native family skips the compatibility directory and scans only `.deepcode/skills`.
- `skills.deny`: excludes specific skills by exact name. Excluded skills aren't loaded at all — they neither show up in the listing nor can be invoked.
- `skills.listingBudgetChars`: the total character budget for every skill's description/`when-to-use` combined in the Skill tool's listing; defaults to 8000.

`skillOverrides` is a per-skill four-state switch, and its semantics are **tighten only, never loosen** — setting an override to a looser state never overrides a stricter setting already present in the skill's own frontmatter (a skill that sets `disable-model-invocation: true`, for example, stays non-model-invocable even if its override is `on`):

| State | Effect |
| --- | --- |
| `on` | Keeps the frontmatter's own settings (the default state) |
| `name-only` | Only the name appears in the listing, no description/`when-to-use` |
| `user-invocable-only` | Not model-invocable — can only be triggered by hand |
| `off` | Fully disabled — neither the model nor manual triggering can use it |

When the listing is rendered, each skill's description/`when-to-use` is first truncated individually; if the combined total still exceeds the character budget, whole entries are dropped starting from the lowest-priority end, with a trailing line in the listing pointing you to `deny`/`sources` or a shorter description.

---

Full details on the `skills` and `skillOverrides` fields, plus layering and stripping rules, are in [settings](/en/config/settings); the full built-in tool list is in [Tools overview](/en/tools/overview).
