# zcode-agent-picker — English edition

Derived from [zcode-agent-picker](https://github.com/Ok541151/cwk) by **Ok541151** (npm: `zcode-agent-picker`), pinned at upstream commit `8d0019e119cb3bc31ba0401809c8375632af13f5` (v0.6.2, 2026-11-01). This edition translates the interface, tool descriptions, and documentation into English. Code semantics are unchanged: tool names (`cli_<id>_direct`), HTTP routes (the `/zcode-agent-picker` prefix), and the roster file (`$DSH_HOME/agent-picker.agents.json`) are identical to upstream, so behavior matches upstream 0.6.2 exactly. The MIT license is retained unchanged in [LICENSE](LICENSE).

**Enable only one edition at a time.** The original and this edition register the same composer control and HTTP routes, and both manage the same roster file — running both at once means duplicate composer controls and competing legacy-cleanup passes.

Install this source as a local zcode bundle using the plugin manager, after disabling the original. Verify that the original is no longer active before enabling this edition. Updates to the original are not applied automatically; review and merge upstream changes deliberately. The original repository is kept as the upstream reference in this same folder (`../upstream/`) — see [`../upstream/README.md`](../upstream/README.md), and read [`../upstream/VOCABULARY.md`](../upstream/VOCABULARY.md) before diffing against upstream: upstream's true bytes use the platform's old name, which this environment renders under the current brand.

---

**Agent mode picker** — adds a control to the right of the composer in the zcode (ZCode) web UI, letting you select an **external Agent CLI** as the current session's default executor, the same way you pick a reasoning-effort tier.

It turns "which external agents exist, and how each one starts" into **data** (`agents.json`), so adding a new agent takes **one data entry — not a code change**.

> **Upgrading from an older version?** Read the [CHANGELOG](./CHANGELOG.md) first — 0.5.0 behaves noticeably differently from 0.4.1 (the list became "what's installed on YOUR machine").

---

## The problem it solves

zcode can call external CLIs, but "which one" usually has to be hard-coded in configuration. This plugin hands the choice back to you: a dropdown to the right of the composer — whoever you pick gets this round. The roster-driven design means **one plugin can carry any number of agents**, including ones you wrote yourself.

## Install

This edition ships as source, not as an npm package:

1. In the plugin manager, disable the original `zcode-agent-picker`.
2. Install this folder as a local zcode bundle (plugin manager → local source).
3. Restart zcode.

On first start the plugin copies its bundled `agents.json` to `$DSH_HOME/agent-picker.agents.json` (by default `~/.zcode/`). **From then on you edit that copy** — plugin upgrades never overwrite it. (The upstream original installs with `zcode plugin add zcode-agent-picker`; that path installs the Chinese original, not this edition.)

## The roster: how to add a new agent

Edit `$DSH_HOME/agent-picker.agents.json` and add one entry to the `agents` array:

| Field | Meaning |
|---|---|
| `id` | Unique identifier |
| `name` | Display name |
| `tool` | The corresponding zcode tool name |
| `bin` | Wrapper file name (used to probe "is it installed") |
| `available` | Initial availability suggestion; **real availability is probed by the plugin** (whether the wrapper exists) |
| `kind` | `task` = task-type (results can be summarized) / `chat` = chat-type (relayed verbatim) |
| `expertise` | The "good at" line shown in the menu |
| `note` | Health status / wiring notes |
| `desc` | Expanded, detailed capability introduction |
| `launch` | **Optional.** Bundled launch recipe: `bin` / `argv` / `env` / `keepEnv` / `timeoutMs` / `graceMs` / `maxBytes`. If present, this plugin registers a `cli_<id>_direct` tool itself |
| `launch.keepEnv` | **Optional.** Whitelist of environment variable **names** to inherit from the parent process (**variables whose names contain `KEY`/`TOKEN`/`SECRET`/`PASSWORD` are stripped by default** — CLIs that authorize via environment variables must be listed here) |
| `keep` | **Optional.** `true` means **never auto-cleaned** (see "legacy leftovers are cleaned automatically" below) |

Restart zcode after editing for changes to take effect.

### Legacy leftovers are cleaned automatically (since 0.6.0)

The plugin seeds a roster only when the roster file does not exist; if it exists, it is never overwritten. But rosters left by old versions often contain a batch of entries pointing at paths on other machines (such as `*-zcode.ps1`) — they can never run on the new machine, yet keep occupying the list. So every start does one thing:

- Entries that can be **proven unrunnable** are removed (criterion: the script referenced by the recipe's `argv` does not exist on this machine)
- A **complete backup** is written to `<roster>.legacy-<timestamp>.bak` before anything is deleted — to recover one, rename the file back
- **"Borrowed" entries without `launch` are never touched** (their tool may be provided by another plugin)
- If there is nothing to delete, the file is not touched by a single byte
- Want to protect an entry? Add `"keep": true` to it

### Path rules for `launch.argv` (important)

The roster travels **across machines**, so **never hard-code absolute paths**. In `argv`, write a **bare file name**; the plugin resolves it at runtime in this order:

```
codex-zcode.ps1            ->  <cliBinDir>/codex-zcode.ps1
{cliDir}/codex-zcode.ps1   ->  <cliBinDir>/codex-zcode.ps1
C:\some\where\x.ps1      ->  kept as-is (for when you deliberately pin an absolute path)
```

`cliBinDir` resolution: the environment variable **`DSH_AGENT_PICKER_CLI_DIR`** takes priority; otherwise the default `~/zcode-clis/bin` (same convention as `zcode-sub-cli`).

### Placeholders

Placeholders available in `argv`: `{task}` (the task body), `{permflags}`, `{permission}`, `{model}`, `{image}`.

**`{permflags}` is special**: it expands into **multiple** arguments, with values taken from the roster's `permFlags[<permission tier>]`; when no tier is specified, `defaultPermFlags` is used. So one template can carry the mapping "permission tier → this CLI's own flags", and callers don't need to know each CLI's syntax.

**`{image}` is only meaningful for CLIs whose command line genuinely supports an image argument** (for example Codex's `-i/--image`). Other CLIs — even ones with image-reading ability of their own — do **not** receive images through this placeholder; in that case put the image path into the task body and let that Agent read it with its own file-reading tools.

## What you need to bring

This plugin **only dispatches; it ships no agents**. Install a CLI and it is discovered and listed automatically.

Detection sources (in order): `PATH` → the managed directory (`~/zcode-clis/bin`, overridable via `DSH_AGENT_PICKER_CLI_DIR`) → `~/.local/bin`.

**The factory roster is empty — by design.** Every member of the list comes from "what was actually probed on this machine". So the list you see depends on which CLIs you have installed; another machine's list depends on theirs.

## Agent compatibility (tested claims)

**31** agent names are recognized out of the box, in two classes:

- **11 with launch recipes** → once probed, directly callable
- **20 recognized only** → they appear in the list (with name and introduction) once probed, but you must add a launch recipe before they can actually be called

> Why not give everyone a recipe: a wrong launch flag is worse than none — it turns into "clickable in the list, error on click". So only parameter sets that were verified get recipes; everything else is honestly marked "needs setup".

### ✅ Has a launch recipe (probed → callable)

| Agent | Launch arguments | Permission mapping | Parameter verification |
|---|---|---|---|
| **Aider** | `--message {task}` | `--dry-run` / `--yes-always` | re-checked against `--help` ✓ |
| **Qwen Code** | `-p {task}` | `--approval-mode plan` / `yolo` | re-checked against `--help` ✓ |
| **Gemini CLI** | `-p {task}` | `--approval-mode plan` / `yolo` | re-checked against `--help` ✓ |
| **Goose** | `run -t {task}` | — | re-checked against `--help` ✓ |
| **Hermes** | `-z {task}` | — | re-checked against `--help` ✓ |
| **Codex** | `exec --skip-git-repo-check {task}` | `-s read-only` / `workspace-write` / `danger-full-access` | taken from a wrapper script proven in daily use |
| **Claude Code** | `-p {task}` | `--permission-mode plan` / `acceptEdits` / `bypassPermissions` | taken from official parameters (not re-verified locally) |
| **Ollama** | `run qwen3:4b {task}` | — | see conditions below |
| **opencode** | `run {task}` | — | official docs document the `run` subcommand; **never run on a real machine** |
| **Cursor CLI** | `-p --trust {task}` | `--mode plan` / `--force` | verified against the official `--help` on a real machine ✓ |
| **Kimi** | `-p {task}` | non-interactive mode has built-in auto permissions | official docs ✓ |

### 🔍 Recognized only, no recipe (shown as "needs a launch recipe")

`GitHub Copilot CLI` · `Trae` · `Amp` · `Droid` · `Augment Code` ·
`OpenHands` · `Cline` · `Windsurf` · `Qoder` · `CodeBuddy` · `Grok CLI` ·
`CodeGeeX` · `Plandex` · `CodeBuff` · `gptme` · `Open Interpreter` ·
(`OpenClaw` · `Kilo Code` · `Crush` · `WorkBuddy`)

When one of these shows up in the list, it looks like this:

```
○ GitHub Copilot CLI     Detected — launch recipe needed
  Auto-discovered (…\copilot.CMD); CLI recognized, but no launch recipe yet
  ─────────────────────────────────────────────
  GitHub's official command-line Copilot — the closest integration with the GitHub ecosystem.
  —— Add a launch entry via the conventional directory or the roster and it becomes callable
```

### How to add a recipe (the plugin walks you through it)

**No need to study this document** — click **"How do I add one? ▼"** on that row in the list, and three steps expand in place:

1. **Find its arguments** — the command comes prefilled with the CLI's real path, one click to copy:
   `"C:\...\copilot.CMD" --help`
2. **Find the one-shot execution flag** — something like `--prompt` / `-p` / `exec` / `run`
3. **Save it as a file in the conventional directory** — the path and the template are both provided by the plugin, with `id` / name / `bin` already filled in; you only edit the `argv` line, and the template is one click to copy:

```json
{
  "id": "copilot",
  "name": "GitHub Copilot CLI",
  "tool": "cli_copilot_direct",
  "kind": "task",
  "launch": { "bin": "C:\\your\\path\\copilot.CMD", "argv": ["-p", "{task}"] }
}
```

After saving, **restart zcode** and it is promoted from the "installable" section to the main list.

> The guidance is **pure hints** — it writes nothing to disk and intercepts nothing. Feel free to ignore it; the row just sits there quietly.

### On the choice of detection names

The shorter a detection name, the easier it **false-positives** (an unrelated program with the same name on the machine gets treated as that agent). So this project has one hard rule: **only detection names of 4+ characters are accepted** — `amp` is the sole exception, because it is Sourcegraph's official CLI name. Existing entries like `Pi` and `Roo Code` were therefore removed, rather than padding the count with guessed names.

Also, **Crush is currently recognized-only, no recipe**: Charm's repository has an open issue requesting a non-interactive batch mode (`charmbracelet/crush#1030`), which means the `crush run <task>` path did not exist at the time. Guessing a subcommand that doesn't exist = the user clicks and gets a guaranteed error, so it's better to offer nothing.

#### Investigated but not included (each for a reason)

| Tool | Why it was left out |
|---|---|
| **iFlow CLI** | Official documentation states the service **ended on 2026-04-17**, with a request to migrate to Qoder |
| **Lingma (Tongyi Lingma)** | Merged into **Qoder**, so only the `qoder` entry is kept, no duplicate |
| **Wenxin Quickcode / Zulu-CLI** | Only the product name could be found, **never a confirmed command name**; a wrong name equals a dead entry |
| **ZCode** | This entry existed in old versions, but its detection name could never be verified — removed in 0.5.1 |

Principle: **fewer names beats guessed names**. The cost of one missing name is "not discovered"; the cost of one wrong name is "a permanently dead row sitting in the list".

### ⚠️ Needs extra conditions

| Agent | Condition |
|---|---|
| **Ollama** | A local ollama service must be running; the recipe hard-codes the model name `qwen3:4b` — if you run a different model, rename it in the roster or the conventional directory |
| **Gemini CLI** | Also needs a protocol translation layer (such as LiteLLM) that converts your endpoint into the Gemini protocol |
| **Qwen Code** | Requires `DEEPSEEK_API_KEY` (it reads `~/.qwen/.env` itself) |
| **Goose** | Requires `GOOSE_PROVIDER` / `GOOSE_MODEL` / `OPENAI_API_KEY` / `OPENAI_HOST` |

> ⚠️ **Variables whose names contain `KEY` in the table above are not passed to child processes by default** (see the "security statement" section below). If a CLI genuinely authorizes via environment variables, whitelist them explicitly in that roster entry:
>
> ```json
> "launch": {
>   "bin": "goose",
>   "argv": ["run", "-t", "{task}"],
>   "keepEnv": ["OPENAI_API_KEY", "OPENAI_HOST", "GOOSE_PROVIDER", "GOOSE_MODEL"]
> }
> ```
>
> It also works without `keepEnv` — as long as the CLI stores its credentials in its own config files (Claude Code and the Codex desktop app both work that way).

### Platform support (the honest version)

| Platform | Status |
|---|---|
| **Windows** | ✅ The author's daily driver; probing, permission mapping, and the call path are all tested in real use |
| **macOS / Linux** | ⚠️ **The code is written POSIX-style, but has never been run on real hardware** |

Parts already pinned down on macOS/Linux (guarded by assertions):

- Commands on `PATH` are matched as **bare names** — it will not try `.COM/.EXE/.BAT/.CMD`
  (this was once written wrong, which made non-Windows probing results **always empty**)
- Absolute paths (such as `/usr/local/bin/claude`) are kept as `argv[0]` as-is, never joined onto another directory
- Paths that are not `.cmd/.bat` do **not** go through the `cmd.exe` wrapper and get **no** `^` escaping
- The task body arrives verbatim (Chinese / spaces / quotes all untouched)

Still unverified: each CLI's own behavior on POSIX. **If you have tried it on a Mac or Linux box, tell me the results** — especially the "detected but launch errors" kind; that is the information I need most.

### ❗ Known trap: **detected ≠ callable**

Don't assume something works just because it appears in the list. Three typical cases:

1. **No recipe** (the 20 above). The list explicitly says "launch recipe needed" —
   it means "I saw that you have this installed", not "I can use it".
2. **Dangling npm shims** (the most common). You installed a CLI with `npm i -g` and later removed the package;
   shims like `claude.cmd` remain, but the `xxx.exe` they point to is gone.
   Probing only checks that the shim file exists → judged "installed"; at call time the child process reports
   **"The system cannot find the path specified"**.
   → Fix: reinstall that CLI, or delete the leftover shim.
3. **Missing credentials / missing service.** Such members are shown as "installed, needs setup" in the installable section, with what's missing spelled out.

**Check whether a shim is still alive**:

```powershell
Get-Content (Get-Command <cmd>).Source     # see which exe it points to, then check that path still exists
```

## Parameters and permissions

The tool arguments include an optional `permission` with the values `read-only` / `workspace-write` / `danger-full-access`.

**It gets translated into each CLI's own arguments** (see the table above); it is not a control enforced by this plugin:

- When omitted, the default tier is used (Codex: `workspace-write`; Aider/Qwen/Claude: the auto-approve tier).
  This is not a matter of taste: a headless run has nobody to click "Allow", so the default tier must be the one
  that won't stall on approvals — otherwise every call waits until timeout.
- For precise control, pass `permission` explicitly, or write your own roster recipe (`permFlags`).

## Parameter convention

All agent tools take the body parameter under the same name, **`prompt`** (paired with a 3–5 word `description` as the title; `task` is a compatibility alias). When adding a new agent, follow this — don't invent new names.

## Host compatibility

`zcode.compatibility` is declared as `>=0.1.5`.
This plugin does **not** depend on settings APIs that shift with host versions, such as `settings.register()` / `installSection()` —
it uses only `ctx.tools.register` / `ctx.tools.guard` / `ctx.subprocess` / `ctx.webServer.register`.

> Background: zcode 0.1.7 removed the old settings registration entry points; any plugin using them throws
> `TypeError: ... is not a function` at startup. This plugin avoids that path by design.

## Security statement (please read)

**The essence of this plugin is: on your machine, start external programs and run tasks, according to your configuration.**

It is not a sandbox, and not a reviewer. Be clear about the following:

### 1. It has the ability to execute programs on this machine

Once chosen as the default executor, the plugin starts the corresponding CLI process, which **inherits your user permissions** (it can read and write whatever you can). So "which agent gets the task" is equivalent to "which program is allowed to work on this machine".

### 2. Three possible abuse surfaces

| Surface | Description |
|---|---|
| **The roster file** | Whatever `launch.bin` / `launch.argv` say in `$DSH_HOME/agent-picker.agents.json` is what the plugin executes. **Whoever can write that file holds local execution rights.** |
| **The conventional directory** | `$DSH_HOME/agent-picker.d/*.agent.json` is a drop directory **any program can write files into**. It delivers exactly the "install it and it appears" convenience — and that is also its risk surface. |
| **Auto-detection** | The plugin searches `PATH`, `cliBinDir`, and `~/.local/bin` for known command names (`codex` / `claude` / `aider` …). **A same-named malicious program placed in one of those directories will be the one that gets picked.** |

### 3. What the plugin does to mitigate

- **Sensitive environment variables are stripped when spawning child processes**: anything whose name contains `KEY` / `TOKEN` / `SECRET` / `PASSWORD` is never passed, and **all `DSH_*` variables are never passed** (session identity must not leak into external processes).
- Every agent has a **timeout cap** (default 15 minutes, overridable per member) and an **output cap** (default 200,000 bytes), so one stuck child process cannot drag the whole session down.
- Agents that are missing environment variables or need a resident service are marked "needs setup" instead of **silently executing**.

### 4. Your responsibilities

- Before use, **take a look** at what is actually inside `agent-picker.agents.json` and `agent-picker.d/`
- **Only install agent CLIs you trust.** The plugin does not vet, sign, or sandbox them
- Do not share the roster file or the conventional directory with untrusted people or programs
- On multi-user machines, watch the directory permissions of `$DSH_HOME`

> In one sentence: **every agent you hand it is one more local execution channel.** Use it with that premise.

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 zcode-agent-picker contributors

You are free to use, modify, and redistribute it (keep the copyright notice). This plugin **ships no agents**; it dispatches third-party CLIs that you installed yourself — honoring those tools' own licenses and costs is your responsibility.

## Development

Upstream:

```bash
git clone https://github.com/Ok541151/cwk.git
cd cwk
```

The offline self-check scripts depend on the host's bundled `@deepseek-ai/zcode-tools`. To run the assertions standalone outside the repository, point `node_modules/@deepseek-ai/` at the host's copy (**do not commit that directory**).

This edition mirrors the upstream tree one-to-one (plus this README). After any translation pass, verify with:

```bash
grep -rP '\p{Han}' lib/ CHANGELOG.md README.md   # must return nothing
node --check lib/index.js && node --check lib/client.js && node --check lib/discover.js
```
