# Changelog

> Only records "what you can feel", not implementation details. To see which lines of code changed, use `git log`.
> History earlier than 0.4.0 was not kept.

---

## 0.6.2

**In one sentence: the panel gained a "Self-test" button — it runs one CLI invocation, completely bypassing the model.**

### Why it was added

The 11-01 live log boxed the problem into a blind corner:

```
14:06:27  Startup v0.6.1 ✓  both tools registered successfully ✓
14:07:11  Prompt segment: Claude Code (cli_claude_direct) · selected=claude   ← instructions delivered correctly
(not a single "invoke" line in the whole log)
```

**The tool was there, the instructions were right, the model just wouldn't call it.** So "does the plugin/CLI pipeline actually work" was forever
blocked behind "will the model deign to call it" — you could never tell which link was broken.

### Now

One more button at the bottom of the panel: **"Self-test <Agent> (no model)"**. Click it, and the plugin itself uses the same
launch recipe to spawn one very short task ("reply with a single phrase: pipeline OK"), then pins the result below:

```
✓ Pipeline OK: Claude Code started and returned
  exit code 0 · took 2140ms
  output: pipeline OK
```

On failure you get the reason directly:

```
✗ Pipeline broken (exit code 1)
  error: …
  stderr: …
  bin: C:\Users\…\npm\claude.CMD
```

**How to read this result:**

| Self-test result | Verdict |
|---|---|
| ✓ OK | Plugin and CLI are both fine → what's left is the model side (open a new conversation and retry) |
| ✗ reports "no launch recipe" | That agent is a borrowed entry; fill in a recipe first |
| ✗ reports the CLI's own error | Look at `stderr` (common: `Not logged in · Please run /login`) |

The self-test **writes no state, changes no selection, touches no conversation** — it runs once and is discarded; the log also keeps one line
`self-test <id>: ok=… exit=… took=…`.

### Two more spots (fixed in passing)

**① The self-test accepts a timeout**: pass `timeoutMs` in the request (3–120 seconds, default 90 seconds).
Sluggish CLIs can be given more slack; and tests can finally genuinely verify "it gets cut off when time is up".

**② The plugin provides its own fallback, so a conversation turn can never hang forever**

The original contract was "the plugin sends the abort signal → the host kills the child process → the call returns". But that was the **host's promise**,
not our guarantee: if the host fails to deliver, `await child-process-completion` is an infinite wait, the whole conversation turn locks up with it,
and all the user sees is "no response" — the hardest kind to troubleshoot.

There is now one more layer of insurance: once `timeout + graceMs + 1 second` has passed with no result, the plugin wraps things up itself and reports honestly:

```
xxx.exe did not return within 3 seconds; aborted (host did not respond to the abort signal; force-wrapped up by the plugin)
```

Live testing covered both kinds of host:

```
Host that honors the abort (ends when it receives it)   → wraps up at 3003ms
Host that ignores the abort                             → hard-fallback wrap-up at 34005ms (3s timeout + 30s grace + 1s)
```

---

## 0.6.1

**In one sentence: fixed the bug where calling it by name threw a graceMs error — the self-healed recipe was a half-finished product.**

### What you hit

The live log (2026-10-29 04:36:43) captured an invocation result for the first time:

```
invoke claude: …\AppData\Roaming\npm\claude.CMD · body 99 chars
return claude: ok=false took=5ms · error=failed to start …\claude.CMD:
  subprocess graceMs must be a positive finite number no greater than 2147483647
```

**The tool was there, the selection was right, the gate let it through — but the host rejected it the moment it started.**

### Root cause

When the "can't run" roster entry was **taken over by auto-discovery**, the plugin hand-rolled a recipe object containing only
`bin` / `argv`, **never going through `parseLaunch`** — so
`graceMs` / `timeoutMs` / `maxBytes` were all `undefined`, and the host
**strictly validates** `graceMs`, rejecting the start outright.

**Why it was never noticed**: all 11 entries on the author's machine are hand-written recipes (through `parseLaunch`, all defaults in place);
only a machine whose "roster entry went bad and was taken over by self-heal" could step on it — namely the claude on the other machine.

### Now

- Self-healed recipes **must pass through `parseLaunch`**, so the defaults are always filled in
  (graceMs=30s, timeoutMs, maxBytes all present)
- Failure logs **record stdout as well** (previously stderr only, which amounted to asking someone to guess from half a sentence)

### One remaining non-bug

On that machine, `claude -p` said it directly:

```
Not logged in · Please run /login
```

**That's the CLI not being logged in — nothing to do with the plugin.** Open `claude` once on that machine, type `/login` to sign in,
and after that it will genuinely run through.

---

## 0.6.0

**In one sentence: old-version leftovers clean themselves up. The list = what really exists on this machine.**

### Why

The previous release merely "prompted you to delete the roster yourself". You were right — that shouldn't be user work:

> What I want is: show whatever is on the machine, and the first version's leftovers should be removed;
> that was the old version, not what the current version should look like

### Now

Every startup does one thing: roster entries that can be **proven unable to run** are deleted
(criterion: the script referenced by the recipe's `argv` does not exist on this machine).

Here is what happens on that machine after the upgrade:

```
Legacy roster cleanup: deleted 9 entries that cannot run on this machine (openclaw, qwen, hermes, aider,
  goose, gemini, ollama, draw, video); original file backed up to
  C:\Users\<you>\.zcode\agent-picker.agents.json.legacy-<timestamp>.bak
```

After that the list holds only **Claude Code** and **Codex** — the two things **really present** on that machine.
Entries like image-gen and video, which were never agents to begin with, disappear along with them.

### Four safety rails

1. **Only what can be proven unable to run gets deleted.** "Borrowed" entries without `launch` are **never deleted** —
   their tools may be provided by another plugin, and deleting them would break something that works fine.
2. **Full backup before deleting** (`<roster>.legacy-<timestamp>.bak`). To recover the old content, just rename the file back.
3. **If there is nothing to delete, not one byte is written.** All 11 entries on your machine run fine? Then the file is never touched.
4. **Want to protect one? Add `"keep": true` to it** — never auto-cleaned.
   (For the case of "write the recipe first, install the CLI later".)

---

## 0.5.8

**In one sentence: it tells you "why the list is still that same old one after upgrading".**

### What you hit

The new catalog clearly has 31 agents, yet after installing you saw exactly the same roster as the first release
(claude / codex / openclaw / qwen / … / image-gen / video); not one of the extra twenty-some appeared.

### Two reasons, neither one a bug

1. **The catalog is a "detection table", not a menu.** Of those 31 entries, only the ones **actually installed on your machine** ever appear —
   which is exactly what you originally asked for: "no agents in the list that my computer doesn't have".
   That machine had only claude and codex, so only they were shown.
2. **Those 11 list entries come from your own roster file**, not from the new catalog.
   The plugin only generates a roster when the roster file **does not exist**; if it exists, it is never overwritten (that is your data).
   So the roster from the 0.4.x era stayed in place, and of course the list looked exactly like the first release.

By the way: **image-gen / video really are not agents**, and they are not among the new catalog's 31 entries either —
they exist only in that old roster (they correspond to `pic-zcode.ps1` / `video-zcode.ps1` on the author's machine).

### Now

The panel shows one extra hint line (when multiple roster entries point to launch scripts that don't exist on this machine):

> 9 roster entries come from the old version and point to launch scripts that don't exist on this machine. To make the list show only the agents genuinely installed on
> this machine: delete (or rename) `<your roster path>`, then restart zcode, and the plugin will automatically generate an empty roster.

**It will not delete it for you** — that is your file. But once it's gone, the list contains only the CLIs actually installed,
and non-agent entries like image-gen/video disappear along with it.

---

## 0.5.7

**In one sentence: one click on an agent = select it; it can no longer be unselected by "clicking once more".**

### The pit you ran into

The live log (2026-10-28 10:18:55) contained only one line:

```
Cache update: session session-ca9408ab… default executor = (unspecified)
```

**There was no record of "claude selected first" at all — it went straight to "unspecified".**
Result: every later message went through ordinary conversation, and claude was never invoked once — which looks exactly like "picked claude but it didn't take effect".

The cause was this design:

```
Click an agent row → if the UI believes "it is already that one", it cancels to (unspecified)
```

As long as the UI's state was even slightly stale (or you were just confirming and clicked twice),
**clicking Claude Code would switch it off** instead of selecting it. That had the same effect as the "No agent" row,
but the UI gave no visible trace of what had happened.

### Now

- **Clicking an agent row always means "select"**; clicking again does not deselect
- To clear the selection, use the **"No agent"** row in the menu (the only exit, with explicit intent)
- The row's hint text was updated accordingly: it no longer says "click again to deselect"

---

---

---

## 0.5.6

**In one sentence: "which step exactly broke" is split into three distinguishable cases.**

### Why

0.5.5 was installed, and the log confirmed claude registered successfully, self-healed successfully, and the other 9 were correctly skipped.
But there was **not a single `invoke` line** — meaning the tool was never executed even once.

That leaves three possibilities, and the log of the time couldn't tell them apart:

| Case | Symptom | Cause |
|---|---|---|
| Prompt segment failed to resolve an executor | The model sees "unspecified" and naturally doesn't call | Cache miss |
| The model didn't call | Prompt segment fine, but the model answered on its own | Model behavior |
| Called but rejected by the host | Our `execute` was never entered at all | Tool not in that session's available list |

### Now

```
Prompt segment: Claude Code (cli_claude_direct) · selected=claude
Gate: allow cli_claude_direct (current executor "Claude Code" is it)
invoke claude: …\npm\claude.CMD · body 42 chars
return claude: ok=false exit=1 took=830ms · error=… · stderr=…
```

- **`Prompt segment: …`** — every turn records "who it resolved to, and what the tool name is". Unspecified is written out directly as `unspecified`.
- **`Gate: allow …`** — appears only when the model **actually invoked** (recorded once per tool).

### How to read the next report

- Only `Prompt segment: unspecified` → cache problem; I'll fix the parsing
- `Prompt segment: Claude Code` present but no `Gate: allow` → the model didn't invoke
- `Gate: allow` present but no `invoke` → rejected at the host layer; the tool never made it into that session's list

---
## 0.5.5

**In one sentence: the log starts recording "what happened after the click".**

### Why

0.5.4 worked exactly as designed on that machine — the log proves it clearly:

```
Startup: zcode-agent-picker v0.5.4 · node v24.18.1 · win32 · DSH_HOME=C:\Users\<you>\.zcode
Repaired 2 roster entries with auto-discovered recipes: codex, claude
Skipped openclaw / qwen / hermes / aider / goose / gemini / ollama / draw / video
```

And yet it still "didn't succeed". The problem: **the log recorded registration, not invocation** — after you pressed the button,
whether claude actually started, what the exit code was, what stderr said — not a single word about any of it.
So every report could only prove "the plugin's configuration is right", never "where the execution failed".

### Now

agent-picker.log gains three new kinds of lines:

```
invoke claude: …\npm\claude.CMD · body 42 chars · permission=workspace-write
return claude: ok=false exit=1 took=830ms · error=… · stderr=…
  argv claude: ["-p","--permission-mode","acceptEdits","<body>"]
 self-heal codex -> …\codex.EXE ["exec","--skip-git-repo-check","{permflags}","{task}"]
```

- **invoke / return**: who was invoked, elapsed time, exit code, error and the start of stderr (the body is recorded as a character count only, never its content)
- **argv**: on failure, the **fully expanded arguments** are recorded, so a mis-assembled argument is visible at a glance
- **self-heal**: what recipe was repaired into place (which bin, what the argv looks like)

### What you need to do

Upgrade, restart, and click that agent once more. **Whether it succeeds or fails, send me the last 20 lines of
%USERPROFILE%\.zcode\agent-picker.log** — with those three kinds of lines above, there is no more guessing.

---
## 0.5.4

**In one sentence: only agents that can genuinely run appear among the options; the log starts recording the version number.**

### Why

After 0.5.3 there was still one machine where clicking did nothing. Its diagnostic report said it all:

```
C:\Users\<you>\zcode-clis\bin    ← the whole directory does not exist
launch of 10 roster entries      → powershell.exe -File qwen-zcode.ps1 …
log                              → all 11 tools "registered successfully"
```

In other words: **the launch scripts didn't exist at all, yet the tools registered anyway**. The user picks qwen in the list,
the gate lets it through, and the first invocation inevitably reports "qwen-zcode.ps1 not found" — clickable, but guaranteed to fail.

There was an even nastier cascade: that state file had **the current session's selection set to qwen**. qwen had no tools,
yet the gate kept insisting "please switch to the tool corresponding to Qwen Code" — a tool that didn't exist at all, so nothing
could be invoked. That was the "cannot converse" state.

### Now

- **Entries whose launch script does not exist no longer register tools**, no longer count as "installed", and never appear among the options.
  The log spells out who was skipped and which file was missing.
- **The gate judges by the actual registration result instead of re-guessing the configuration**: if the selected executor has no usable
  tool, it falls through as (unspecified) with a log line, instead of locking out the other agents along with it.
  Prompt segment, panel, and gate now give the same answer to "does this session have an executor".
- **The log opens with the version number**: `Startup: zcode-agent-picker v0.5.4 · node … · DSH_HOME=…`.
  The previous report gave roster, state, where, and the npm directory — but nowhere a hint of which version was running.
- **Self-heal records now also go into `agent-picker.log`** (previously only `harness.log`, and the reports collected the former).
- **The log is now written synchronously**: async appends briefly hold the file handle, which made "delete DSH_HOME" (resetting plugin
  state, cleaning temp directories) fail to delete with EPERM.

### What you'll see

After upgrading on that machine: the list holds only claude and codex, plus one extra line "8 more not installed on this machine".
The unclickable qwen no longer pretends to be selectable; even if the state still remembers qwen, the session can use other agents as usual
(the prompt segment will show "unspecified").

---

## 0.5.3

**In one sentence: fixed "the tool is right there in the list, yet clicking it errors out".**

### What you hit

codex / qwen and the rest were in the list, looked fine, and failed the moment you clicked execute.

The reason: in the old roster they were launched like this:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex-zcode.ps1 …
```

`powershell.exe` exists on every Windows machine, so 0.5.2 judged "this entry can run" and never reached for the
real CLI found by detection — while the `codex-zcode.ps1` it was supposed to execute did not exist on your machine at all.

### Now

Judging "can this entry run" no longer looks only at the launcher's first argument; it also checks whether the
**script file referenced by the command exists**. If it is not found, it switches to the real CLI found by detection (for example the `codex.exe` bundled with the desktop app),
and states "switched to the detected recipe" in the description.

**The reverse is guarded too**: if that `*-zcode.ps1` on your machine genuinely exists (the author's own machine is that case),
**not a single character is touched** — your hand-configured wrappers are never overwritten.

### What you need to do

**Upgrade and restart zcode. That's all.**

---

## 0.5.2

**In one sentence: fixed "clearly installed, yet not detected".**

### What you hit

claude and codex were both installed on that machine, yet the plugin recognized neither — the two rows in the list actually came from the
old roster, carrying copy from the author's machine, and clicking them invoked nothing.

The reason: they were **not on PATH**:

| Agent | Actual location | Why it was not found |
|---|---|---|
| claude / qwen | `npm i -g` installs into `%APPDATA%\npm` | When zcode starts from the graphical interface, that directory is often missing from PATH |
| codex | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` bundled with the ChatGPT desktop app | Not on PATH, not in a fixed directory, and the hash name changes on every update |

### Now

Beyond PATH, these locations are searched proactively:

- `%APPDATA%\npm`, `%LOCALAPPDATA%\npm` (npm global)
- `~/.npm-global/bin`, `~/.local/bin` (POSIX npm / pipx)
- `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (ChatGPT desktop app; newest by modification time wins)

### Three more spots (found during self-testing)

- **Agents your machine doesn't have no longer appear in the list** — those came from the old roster.
  Exception: **the currently selected one always stays visible**, otherwise you have no entry point to switch away from it.
- **Bare names in the roster (`bin: "claude"`) are recognized too**, and won't be judged "not installed" and hidden just because
  they live in `%APPDATA%\npm`.
- **CLIs without a permission switch say so plainly** — goose / hermes / opencode / kimi and their kin don't recognize
  "read-only / edits / full", so the list now states it outright instead of letting you believe they are governed.
- **Empty values no longer become empty arguments** — with no model / image specified, `--model {model}` used to expand into
  `--model ""`; many CLIs treat an empty string as one bad value. Now that whole segment is dropped.
- **The `zcode.compatibility` field was removed** — not a single line of code anywhere in zcode read it,
  and under strict semver its value doesn't match pre-release hosts like `0.1.7-rc.2`; keeping it was a liability.
- **No webServer no longer drags down host startup** — zcode startup is all-or-nothing: if the plugin throws one exception during
  loading, the whole process exits (the user only sees zcode fail to open, with no way to find out who).
  A missing webServer now quietly skips route registration; the prompt segment and executors work as usual.
- **Cancelled invocations no longer spawn processes** — after you hit stop, nothing should spawn a CLI that has no one collecting
  its output and no one reaping it.

### What you need to do

**Upgrade and restart zcode. That's all.** The installed claude / codex will appear in the list on their own,
with names and descriptions rewritten for your machine.

---

## 0.5.1

**In one sentence: fixed "still no good after upgrading to 0.5.0".**

### What you hit (after going from 0.4.x to 0.5.0)

0.5.0 emptied the factory roster, but **left your own copy untouched**: `~/.zcode/agent-picker.agents.json`.
That one was left over from the old version: its `claude` entry read "borrowed entry point", and the other members pointed to wrapper scripts on the
author's machine — not one of which existed on yours. **The roster takes precedence**, so the upgrade changed nothing:

```
log: skipping claude: no launch recipe (borrowing cli_claude_direct)
symptom: Claude Code selected, yet not one external agent could run — zcode itself still did the work
```

### What happens now

- Roster entries that **cannot run on this machine** are automatically patched up with detected recipes
  (the log will say "repaired N roster entries")
- **Names and descriptions are rewritten for your machine too** — the old roster's line "Local CLI 2.1.278 · via DeepSeek
  endpoint" was a version number from the author's machine and meant nothing on yours; the old-style "(web ✅ images ✅ docs ✅ speech ✅)"
  is likewise replaced with this machine's real state
- Roster entries that are written correctly are **not touched at all** — agents you added yourself are left alone
- A roster beginning with a **BOM** (as written by Notepad / PowerShell) can now be read too
  — previously the whole file was discarded as corrupt

### What you need to do

**Just upgrade — no need to delete the roster or hand-edit anything.**

---

## 0.5.0

**In one sentence: fixed "installed on someone else's computer, it won't invoke".**

### Coming up from 0.4.1, the changes you'll see

| | Before (0.4.1) | Now (0.5.0) |
|---|---|---|
| What's in the list | **The 11 the author had installed**, same on any computer | **Whatever is installed on this machine of yours** |
| Does a click actually invoke? | Mostly no (points at the author's scripts, absent on your machine) | All 11 with launch recipes can |
| Installed but not configured | Mixed in with the "working" ones, indistinguishable | Goes into "Installable" separately, stating what's missing |

### What you can do now

- **Install any CLI and it appears in the list after a restart** — no configuration, no file editing
- **Copilot / Trae and the other not-yet-supported ones**: click "How to add it?" for a three-step guide: check the arguments → change one line → restart
- **Permission tiers are translated into each CLI's own arguments** (read-only / edits / full), no longer always wide open

### Real bugs fixed

1. **Selected Claude Code, and nothing could run** — its entry point originally counted on another plugin to provide it;
   when that plugin was absent there was no hint at all, and it locked out every other agent along with it.
2. **Detection always came up empty on macOS / Linux** — the code had applied Windows' extension-name rules.
3. **"＋" could put not-yet-configured members into the main list** — useless once there; same pit as 1.

### What you need to do

**Usually nothing at all.**

Only one case to watch: if you wrote your own `~/.zcode/agent-picker.agents.json`,
**it still takes precedence**, and your configuration will not be overwritten.

---

## 0.4.1

**In one sentence: adds the security disclosure.**

The plugin lets external programs do work on your machine — that fact used to live only in the code; now it is written in the README:
which of your permissions it inherits, what abuse surfaces exist, what mitigations the plugin applies, and what responsibility falls on you.

No functional change.

---

## 0.4.0

**In one sentence: first public release.**

- Pick an external agent CLI next to the input box as this session's default executor
- The agent catalog is data-driven: adding one means adding one data entry, no code changes
- Published to npm and GitHub

---

## How to read these version numbers

For three-part numbers like `0.5.0`: **a changed middle digit** usually means "behavior will differ after the upgrade",
worth a glance at the "changes you'll see" section above. A changed last digit is basically always safe to upgrade blindly.