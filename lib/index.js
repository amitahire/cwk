/**
 * zcode-agent-picker — host half.
 *
 * Makes an external Agent CLI the DEFAULT EXECUTOR for the conversation, like a
 * reasoning-effort level rather than a per-message command.
 *
 * The agent roster is DATA, not code: `agents.json` beside this package lists
 * every agent (id / name / tool / bin / available), so adding a new CLI is an
 * edit to that file — no plugin change needed. An agent is offered as an active
 * choice only once it has actually been enabled on this machine (see
 * `enabledIds()`); agents that are merely listed show up in the UI's
 * "installable" area instead.
 *
 * How the routing works (verified against this zcode build, not guessed):
 *   - The browser half owns the UI and POSTs the chosen mode to
 *     `/zcode-agent-picker/mode`.
 *   - This half persists it to `<DSH_HOME>/agent-picker.json` and re-registers
 *     its system-prompt section so the section names the active executor.
 *   - `zcode-agent-loop` `preStep()` calls `systemPrompt.assemble()` and
 *     `renderContextSections()` on EVERY step, so the text is re-read each turn:
 *     changing it takes effect on the next user message, with no message
 *     rewriting and no visible marker in the transcript.
 *
 * Safety rule: never throw out of apply(). The web shell fails the whole boot
 * when a plugin's apply throws (that is how zcode-agent-team-gui once took every
 * third-party plugin down).
 *
 * @module zcode-agent-picker
 */

import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/zcode-tools'
import { discoverAgents, resolveOnPath, resolveInDir, defaultSearchDirs } from './discover.js'

/**
 * Required services: the web route registry, the prompt band, and — for agents
 * that declare an inline `launch` recipe — the tool registry and subprocess.
 */
export const inject = ['webServer', 'systemPrompt', 'tools', 'subprocess']

/**
 * Executor kinds, the extension point that makes this plugin hold MANY agents.
 *
 * A roster entry is executable in exactly one of two ways:
 *
 *   tool    — zcode already has a tool for it (that is how zcode-sub-cli's managed
 *             `cli_claude_direct` / `cli_codex_direct` work: they carry session
 *             continuity, verification and permission tiers we must not
 *             reimplement). The picker only names the tool in its prompt
 *             section; it does not own execution.
 *   launch  — the entry carries its own headless command line, and this plugin
 *             registers the tool itself (`cli_<id>_direct`) so the agent is
 *             callable without touching any other plugin. This is the path for
 *             agents zcode has never heard of, e.g. OpenClaw.
 *
 * Adding a new agent is therefore a roster edit in either case; only a
 * genuinely new *execution shape* would need code here.
 */
const LAUNCH_TOOL_SUFFIX = '_direct'

/**
 * Upper bound for a `setTimeout` delay: 2^31-1 ms.
 *
 * Node OVERFLOWS past this and fires the callback IMMEDIATELY (with a
 * TimeoutOverflowWarning), so a roster with a very large `timeoutMs` would
 * invert the intent and kill every call instantly. A deadline is clamped
 * instead, which is at worst "effectively no deadline".
 */
const MAX_TIMER_DELAY_MS = 2147483647

/** The roster file that ships beside this package (used only to seed). */
function packagedRosterFile() {
  return fileURLToPath(new URL('../agents.json', import.meta.url))
}

/**
 * Where the managed CLI wrappers live.
 *
 * Portable by default: `$DSH_AGENT_PICKER_CLI_DIR` wins, else `~/zcode-clis/bin`
 * (which is what zcode-sub-cli uses on this deployment, so nothing changes for an
 * existing install). A roster entry may also point anywhere with an absolute
 * path — see `expandLauncherToken` below.
 */
export function cliBinDir() {
  const configured = process.env.DSH_AGENT_PICKER_CLI_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), 'zcode-clis', 'bin')
}

/**
 * Expand a `{cliDir}`-prefixed argv token, and resolve a BARE wrapper filename
 * against `cliBinDir()`.
 *
 * Why this exists: a published roster cannot hardcode `C:\Users\<who>\...`.
 * Instead a recipe writes the wrapper's NAME and the plugin resolves it here:
 *   `codex-zcode.ps1`            -> `<cliBinDir>/codex-zcode.ps1`
 *   `{cliDir}/codex-zcode.ps1`   -> `<cliBinDir>/codex-zcode.ps1`
 * Anything that already looks like a path (drive letter, leading `/`, `\`, `.`)
 * is left untouched, so an operator can still pin an absolute path by hand.
 */
function expandLauncherToken(token) {
  if (token.startsWith('{cliDir}')) {
    return path.join(cliBinDir(), token.slice('{cliDir}'.length).replace(/^[\\/]+/, ''))
  }
  if (/^[A-Za-z]:[\\/]/.test(token) || /^[\\/]/.test(token) || token.startsWith('.')) return token
  if (!/(^|[\\/])[^\\/]+\.(ps1|cmd|bat|exe|sh)$/i.test(token)) return token
  // A BARE wrapper filename always resolves under cliBinDir -- deliberately NOT
  // gated on existsSync. If the wrapper is missing we want the accurate
  // "Cannot find executable <abs path>" error from the resolver below, instead of
  // handing the child a bare name that PowerShell then hunts for on PATH and
  // fails on in a confusing way.
  return path.join(cliBinDir(), token)
}


/** The zcode home directory (`$DSH_HOME`, else ~/.zcode). */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.zcode')
}

/**
 * The USER-EDITABLE roster. Deliberately not inside the package: the package
 * lives in the profile's node_modules (a copy, refreshed on every reinstall),
 * so edits there would be lost. This path is stable and safe to hand-edit.
 */
export function rosterFile() {
  return path.join(dshHome(), 'agent-picker.agents.json')
}

/** Where the selected mode + enabled roster are persisted. */
function stateFile() {
  return path.join(dshHome(), 'agent-picker.json')
}

/**
 * Raw fallback roster used when `agents.json` is missing or malformed, so a
 * broken data file degrades to something usable instead of an empty picker.
 *
 * Do not use this array directly — always go through `FALLBACK_ROSTER` below,
 * which runs it through the same normalizer as a real roster file.
 */
// The factory roster is empty — deliberately.
//
// This used to hold (as does agents.json) the 11 members from the author's own
// machine: every entry hard-coded `available: true` and pointed `launch` at the
// author's own `~/_dsh-clis/bin/*-zcode.ps1` wrapper scripts. On other machines
// that had two fatal consequences:
//
//   1. The UI listed everything the AUTHOR had installed and others had not as
//      "installable" — the list had nothing to do with the actual machine;
//   2. Even when the local machine had a CLI of the same name, it could not be
//      called, because the recipe pointed at a wrapper script that did not exist.
//
// The right approach is to let lib/discover.js's BUILTIN_AGENTS decide: it scans
// the local PATH / cliBinDir / ~/.local/bin, using each CLI's own native
// arguments (and carrying the permission tier → native flag mapping); `ready`
// is computed from the machine's actual state. The roster remains available —
// but as "the user's custom override layer", not as factory defaults. The
// conventional directory $DSH_HOME/agent-picker.d/*.agent.json works the same way.
const RAW_FALLBACK_ROSTER = []

// Defaults for a launch recipe. Bounding the child is a resource concern, not a
// cosmetic one: without a deadline a hung agent owns the turn forever, and
// without a byte cap a chatty one is retained in memory without limit.
//
// Declared BEFORE `FALLBACK_ROSTER` on purpose: that const is built at module
// load and goes through `parseLaunch`, so these must already be initialized or
// the module throws a temporal-dead-zone error on import.
const DEFAULT_LAUNCH_TIMEOUT_MS = 900000
const DEFAULT_LAUNCH_GRACE_MS = 30000
const DEFAULT_LAUNCH_MAX_BYTES = 200000

// Keys that must never reach an external agent. Mirrors the host's own
// SENSITIVE_ENV_PATTERN; `DSH_*` is handled separately in buildChildEnv.
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The fallback roster, normalized through the SAME path as a real roster file.
 *
 * This is not cosmetic. `readRosterSync` / `readRoster` / `parseRosterText` all
 * fall back to this list when the data file is missing or unparseable, and they
 * used to return the raw literals above. Those literals carry a `launch` recipe
 * that had never been through `parseLaunch`, so its defaults silently did not
 * exist:
 *
 *   stdio.stdout = {}   -> maxBytes undefined
 *
 * The subprocess collector uses the caller's spec verbatim
 * (`new OutputCollector(mode.maxBytes, ...)`) and tests overflow with
 * `bytes + chunk.length > maxBytes`. Compared against `undefined` that is
 * always false, so NOTHING was ever trimmed: one runaway or merely chatty
 * agent would have its entire stdout retained in memory with no cap. The
 * deadline and grace defaults were lost the same way.
 *
 * One JSON typo in `agents.json` reaches this path — and the menu footer
 * actively invites the user to edit that file. Normalizing here means there is
 * exactly one way an agent entry gets built, so the fallback cannot drift from
 * the real thing again.
 */
const FALLBACK_ROSTER = RAW_FALLBACK_ROSTER.map(normalizeEntry).filter(Boolean)

/** Whether a file exists; never throws. */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Normalize one `launch` recipe, or null when there is nothing usable.
 *
 * `argv` is an argument template; `{task}` / `{model}` / `{permission}` /
 * `{image}` are filled in by `runLaunch`. `{permflags}` is special: it expands
 * into SEVERAL arguments taken from `permFlags[<permission>]`, or from
 * `defaultPermFlags` when no permission was given — so one template can carry a
 * per-CLI permission mapping without the caller knowing each CLI's flags.
 *
 * Returning a fully-populated object is what makes the defaults above reach the
 * subprocess — an entry that skipped this step used to run with an undefined
 * output cap.
 */
function parseLaunch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.bin !== 'string' || raw.bin === '') return null
  const argvRaw = Array.isArray(raw.argv) ? raw.argv.filter((a) => typeof a === 'string') : ['{task}']
  const env = {}
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  const keepEnv = Array.isArray(raw.keepEnv) ? raw.keepEnv.filter((k) => typeof k === 'string') : []
  const positive = (value, fallback) =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
  const argvList = (value) =>
    (Array.isArray(value) ? value.filter((a) => typeof a === 'string') : [])
  const permFlags = {}
  if (raw.permFlags && typeof raw.permFlags === 'object' && !Array.isArray(raw.permFlags)) {
    for (const [key, value] of Object.entries(raw.permFlags)) {
      const list = argvList(value)
      if (list.length > 0) permFlags[key] = list
    }
  }
  return {
    bin: raw.bin,
    argv: argvRaw.length > 0 ? argvRaw : ['{task}'],
    env,
    keepEnv,
    permFlags,
    defaultPermFlags: argvList(raw.defaultPermFlags),
    timeoutMs: positive(raw.timeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS),
    graceMs: positive(raw.graceMs, DEFAULT_LAUNCH_GRACE_MS),
    maxBytes: positive(raw.maxBytes, DEFAULT_LAUNCH_MAX_BYTES),
  }
}

/**
 * Environment for one launched agent.
 *
 * Handing the subprocess layer an explicit env does not ADD to the inherited
 * one, it OVERRIDES it (the runner deletes same-named inherited keys, then
 * pushes ours) — so the scrubbing the host would have done has to be repeated
 * here, or it silently does not happen. Two families are dropped: secrets, and
 * every `DSH_*` value, because those are harness facts (`DSH_HOME`,
 * `DSH_SESSION_ID`, `DSH_SUBPROCESS_*`), not the agent's business — handing an
 * external process the session identity is not a cosmetic leak. `keepEnv`
 * remains the escape hatch.
 */
export function buildChildEnv(launch) {
  const out = {}
  const keep = new Set((launch.keepEnv || []).map((k) => k.toUpperCase()))
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (!keep.has(upper) && (SENSITIVE_ENV_PATTERN.test(key) || upper.startsWith('DSH_'))) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(launch.env || {})) out[key] = value
  return out
}

// cmd.exe re-parses the entire command line, so an argument containing any of
// these is split or redirected before the child ever sees it. `^` is cmd's own
// escape: cmd removes it and the child receives the literal character.
const forCmd = (s) => s.replace(/[&|<>^]/g, '^$&')

/**
 * Resolve, spawn and collect one launch recipe.
 *
 * Resolution order matters: prefixing the unified dir would turn an absolute
 * path into a nonsense path, so absolute paths are tried as-is first.
 *
 * @returns a plain result object; never throws.
 */
/**
 * Translate a permission level into this CLI's own flags.
 *
 * When no level was given (or the level is not in the map) this falls back to
 * `defaultPermFlags`. That fallback is not cosmetic: a headless CLI with no
 * explicit approval posture either refuses to write files (codex defaults to
 * `read-only`) or blocks waiting for an approval nobody can click.
 */
function resolvePermFlags(launch, permission) {
  const key = String(permission == null ? '' : permission).trim().toLowerCase()
  const map = launch.permFlags || {}
  if (key !== '' && Array.isArray(map[key]) && map[key].length > 0) return map[key]
  return Array.isArray(launch.defaultPermFlags) ? launch.defaultPermFlags : []
}

async function runLaunch(ctx, launch, { task, model, permission, image, workspace, signal }) {
  // Do not spawn a process for an already-cancelled call.
  //
  // Once the user pressed stop, or the turn has already ended, the host's signal is in the aborted
  // state; spawning a CLI then means nobody reads its output and nobody reaps the process —
  // nothing but an orphan process and a bill. Reporting that honestly is cleaner than
  // "started, but nobody wants the result".
  if (signal && signal.aborted) {
    return { ok: false, error: 'This call was already cancelled; no process was started' }
  }
  const permFlags = resolvePermFlags(launch, permission)
  const args = []
  for (const token of launch.argv) {
    // `{permflags}` expands into SEVERAL arguments: one level can be two tokens
    // (`-s read-only`). Everything else is a 1:1 string template.
    if (token === '{permflags}') {
      for (const flag of permFlags) args.push(flag)
      continue
    }
    args.push(
      expandLauncherToken(token)
        .split('{task}').join(task)
        .split('{model}').join(model || '')
        .split('{permission}').join(permission || '')
        // `{image}` is an optional image path. Only entries whose argv mentions it
        // get one; others simply never see the token. Measured: Codex is the only
        // CLI here that accepts an image (`-i/--image`), and zcode hands the model a
        // real path for a user attachment, so this can be wired end to end.
        .split('{image}').join(image || ''),
    )
  }

  // Empty placeholders must not become "empty arguments".
  //
  // When the user specified no model / image, `--model {model}` expands to `--model ""`. Many CLIs
  // treat the empty string as a real (invalid) value — so "did not pass this argument" quietly became
  // "passed a bad value". Measured on a real machine: empty strings really did show up in argv.
  //
  // Handling: drop the empty argument; and if it is immediately preceded by a `--flag`-shaped
  // literal, drop that too, so no valueless switch is left behind.
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] !== '') continue
    args.splice(i, 1)
    if (i > 0 && /^--?[A-Za-z][\w-]*$/.test(args[i - 1])) args.splice(i - 1, 1)
  }

  let resolved = null
  for (const candidate of [launch.bin, path.join(cliBinDir(), launch.bin)]) {
    try {
      resolved = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
    } catch {
      resolved = null
    }
    if (resolved) break
  }
  if (!resolved) {
    return { ok: false, error: `Cannot find executable ${launch.bin} (looked in the unified directory ${cliBinDir()})` }
  }

  // Windows: an npm/batch shim (.cmd/.bat) cannot be spawned directly.
  //
  // It has to go through cmd.exe, which re-parses the whole command line — so
  // ONLY this branch gets `^`-escaping. A real executable receives argv
  // verbatim, and escaping there would corrupt its arguments instead.
  let argv = [resolved, ...args]
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // Literal 'cmd.exe', not ComSpec: the offline verification pins the exact
    // argv shape (`['cmd.exe','/d','/c', …]`), and PATH resolution of the
    // literal is what the original did.
    argv = ['cmd.exe', '/d', '/c', resolved, ...args.map(forCmd)]
  }

  // Default to '.', not undefined: the offline verification pins the cwd handed
  // to the subprocess layer, and omitting it would let the runner pick its own.
  const cwd = workspace || '.'
  const env = buildChildEnv(launch)
  const io = {
    stdin: 'ignore',
    stdout: { maxBytes: launch.maxBytes },
    stderr: { maxBytes: launch.maxBytes },
  }

  // Arm the deadline here, in this layer.
  //
  // The subprocess layer has no overall timeout — only `graceMs`, which is "how
  // long to wait after a termination request before killing", not a deadline.
  // A wedged agent (a gateway that never answers, say) would otherwise own the
  // turn forever with nothing to stop it. Relaying the caller's abort signal
  // and the deadline into ONE controller means "the user stopped it" and "it
  // timed out" travel the same, already-proven abort path.
  const deadlineMs = Math.min(launch.timeoutMs, MAX_TIMER_DELAY_MS)
  const control = new AbortController()
  const relayAbort = () => control.abort()
  if (signal) {
    if (signal.aborted) control.abort()
    else signal.addEventListener('abort', relayAbort, { once: true })
  }
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    control.abort()
  }, deadlineMs)
  // Deliberately NOT unref'd. An unref'd timer does not keep the loop alive, so
  // if nothing else is pending the deadline is simply skipped and the call hangs
  // forever — which is the exact failure this deadline exists to prevent. The
  // timer cannot outlive the call anyway: `release()` below always clears it,
  // and while a real child is running its process handle holds the loop open.

  const release = () => {
    clearTimeout(deadline)
    if (signal) signal.removeEventListener('abort', relayAbort)
  }

  let handle
  try {
    handle = ctx.subprocess.spawn({ argv, cwd, env, signal: control.signal, stdio: io, graceMs: launch.graceMs })
  } catch (error) {
    release()
    return { ok: false, error: 'Could not start ' + launch.bin + ': ' + String((error && error.message) || error) }
  }

  // Hard fallback: even if the host never responds to the abort signal we sent, this turn must
  // **not** be allowed to hang forever.
  //
  // The normal contract is "abort signal → host kills the child process → done settles". But that is
  // the host's PROMISE, not our GUARANTEE: the moment it fails to deliver, `await handle.done` is an
  // infinite wait, the whole conversation turn wedges with it — and what the user sees is "no
  // reaction", the hardest kind to debug.
  //
  // So here we add one more layer of insurance: if there is still no result by
  // deadline + graceMs + 1 second, close out ourselves and report honestly that the host did not
  // respond to the abort. It should never trigger; if it does, there is an upstream bug — and this
  // layer still guarantees we can produce a definite failure reason.
  const hardMs = Math.min(deadlineMs + Math.max(0, launch.graceMs || 0) + 1000, MAX_TIMER_DELAY_MS)
  let hardTimer = null
  let outcome
  try {
    outcome = await Promise.race([
      handle.done,
      new Promise((_resolve, reject) => {
        hardTimer = setTimeout(() => {
          try { if (handle && typeof handle.kill === 'function') handle.kill() } catch { /* ignore */ }
          const err = new Error('Host did not respond to the abort signal (waited ' + Math.round(hardMs / 1000) + ' s)')
          err.__pickerHardTimeout = true
          reject(err)
        }, hardMs)
      }),
    ])
  } catch (error) {
    if (hardTimer) clearTimeout(hardTimer)
    release()
    const hard = error && error.__pickerHardTimeout === true
    return {
      ok: false,
      aborted: hard || timedOut,
      error: timedOut || hard
        ? (launch.bin + ' did not return within ' + Math.round(deadlineMs / 1000) + ' s; aborted'
          + (hard ? ' (host did not respond to the abort signal; the plugin force-closed it)' : ''))
        : (launch.bin + ' run interrupted: ' + String((error && error.message) || error)),
    }
  }
  if (hardTimer) clearTimeout(hardTimer)
  release()

  // The kill also settles `done` normally, so the deadline has to be checked on
  // the success path too — otherwise a timed-out run would be reported as a
  // plain non-zero exit and the real reason would be lost.
  if (timedOut) {
    return { ok: false, error: launch.bin + ' did not return within ' + Math.round(deadlineMs / 1000) + ' s; aborted' }
  }

  const read = (key) => {
    try {
      const collected = handle.collected && handle.collected[key]
      if (!collected) return { text: '', lossy: false, spillPath: null }
      const got = collected.readFrom(0) || {}
      return {
        text: typeof got.text === 'string' ? got.text : '',
        lossy: got.lossy === true,
        spillPath: typeof got.spillPath === 'string' ? got.spillPath : null,
      }
    } catch {
      return { text: '', lossy: false, spillPath: null }
    }
  }
  const stdoutRead = read('stdout')
  const stderrRead = read('stderr')
  const stdout = stdoutRead.text
  const stderr = stderrRead.text
  const exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null
  // `argv` is returned too: on failure the caller logs it, to judge "were the
  // arguments assembled correctly". Read-only use — the caller only shows it
  // when !ok, and replaces the body with a placeholder.
  const out = { ok: exitCode === 0, exitCode, argv: args.slice(), stdout, stderr: stderr.trim() }

  // Report truncation instead of hiding it.
  //
  // `readFrom(0)` is LOSSY once the collector had to drop anything: it then
  // returns the retained TAIL window, not the delta from byte 0. This code used
  // to keep only `.text`, so a run whose output exceeded `maxBytes` (default
  // 200 KB) came back looking like a complete answer — and `ok` is decided by
  // the exit code, so it even reported success. For a chat agent, whose reply
  // the host model is told to relay VERBATIM, that silently hands the user a
  // truncated reply as if it were the whole thing.
  if (stdoutRead.lossy || stderrRead.lossy) {
    out.truncated = true
    out.truncatedNote =
      `Output exceeded the cap (${launch.maxBytes} bytes); only the **tail** is shown below — the beginning was dropped`
      + (stdoutRead.spillPath ? `. Full output saved to: ${stdoutRead.spillPath}` : ' and could not be recovered (spill-to-disk overflow is not enabled)')
      + '. Do not treat this as the complete result; if needed, have the task write results to a file and read them in segments.'
  }

  if (!out.ok && out.error === undefined) {
    // A failure must always say WHY. Without this, a killed-but-talkative run
    // returned `ok:false` with no `error` at all, and the reason was simply lost.
    const tail = stderr.trim().split('\n').slice(-4).join(' | ')
    out.error = tail !== ''
      ? tail
      : (exitCode === null
        ? 'The external agent was aborted and did not exit normally (and printed no error)'
        : stderr.trim() === ''
          ? 'The external agent returned nothing at all'
          : 'exit code ' + exitCode + ' (details in stdout)')
  }
  return out
}

/**
 * The roster's tool names, whichever executor kind they use.
 *
 * `tool` entries borrow a tool from another plugin (Claude Code / Codex), and
 * `launch` entries get theirs registered by this plugin — but they are the SAME
 * kind of thing from the selector's point of view: "the tool that runs agent X".
 */
function agentToolNames(roster) {
  const names = new Map()
  for (const entry of roster) {
    const name = entry.launch ? (entry.tool || ('cli_' + entry.id + LAUNCH_TOOL_SUFFIX)) : entry.tool
    if (typeof name === 'string' && name !== '') names.set(name, entry)
  }
  return names
}

/**
 * The "plain-language" version of the gate rules, shown only in the UI's
 * mechanism panel.
 *
 * ⚠️ It and the `agentToolGuard` right below are **two expressions of the same
 * semantics**: whenever the gate changes, this must change with it. There is no
 * way to generate one from the other — those rules are `if` statements, not
 * data. Placing them side by side is what makes the next editor see both.
 *
 * (The "exact instructions the model received" item is NOT like this: `/inspect`
 * calls `modeGuidance()` directly for it — the same function the prompt section
 * uses — so it cannot drift.)
 */
const GATE_RULES = [
  'The agent selected for this session is the one being called -> allow',
  'This session selected A, but B\u2019s tool is called -> block, and state who the current executor is',
  'No agent selected for this session -> allow (explicitly naming an agent still works)',
  'The selected id is no longer in the roster -> allow as "unset" (e.g. that agent was deleted from agents.json)',
  'The gate itself throws, or the call carries no session identity -> always allow (rather miss a block than kill a legitimate call)',
]

/**
 * The nature notes in the "mechanism" panel. Adjacent to `GATE_RULES` for the
 * same reason: they describe the gate's **boundary**.
 *
 * The last one is a loophole the USER spotted, and it must be spelled out — it is
 * the most misunderstood part of the whole mechanism: the gate blocks **one tool
 * call**, while "I answer it myself" is not a tool call at all, so there is
 * nothing to block. The mode is therefore a [routing requirement], not
 * [enforcement]: it constrains "you may not call the wrong one" and does
 * **not** guarantee "the message must be handed over".
 */
const GATE_NOTES = [
  'This choice is PER-SESSION: it affects only the current conversation; other sessions are independent.',
  'The executor is locked once a turn starts: switching mid-turn only takes effect on the next message.',
  '\u26a0 The mode is a [routing requirement], not [enforcement]. What the gate blocks is "calling another agent\u2019s tool", '
  + 'while "answering it myself" is not a tool call — there is nothing to block. So while an agent is selected, '
  + 'if I never hand the message over and answer it myself, nothing mechanically stops that \u2014 it is a convention, not a mechanism.',
]

/**
 * A synchronous accept/deny check for one agent-backed tool call.
 *
 * SEMANTICS (mode "B", chosen by the user 2026-09-21):
 *   - an agent is selected IN THIS SESSION, and it IS the one being called -> allow
 *   - an agent is selected in this session, but a DIFFERENT one is called   -> deny
 *   - NO agent selected in this session                                     -> allow
 *
 * "This session" is essential: the choice is per conversation, so the predicate
 * resolves it from the execution's own agent (`exec.agent`) rather than from one
 * process-wide value. A call from a session that never chose anything is the
 * unset case, never another session's choice.
 *
 * The last case matters: "no agent selected" means plain conversation, not "forbid all
 * agents". A user who explicitly asks for Codex by name in plain conversation
 * must still get it. The mode only decides the DEFAULT executor; it does not
 * take away explicit requests.
 *
 * HARD REQUIREMENT (this is what broke the whole tool system once): zcode's
 * `tools.guard()` takes a **synchronous** predicate and calls it as
 * `guard(exec)`; it does no awaiting. An `async` guard returns a Promise, so
 * `guard(exec)` throws `guard is not a function` — and because a plain-context
 * guard applies to EVERY tool in the Host, that single mistake rejects every
 * tool call in the app, not just this plugin's.
 *
 * Therefore this function must (a) be a plain function, and (b) do no I/O. It
 * reads the active mode from the caller's in-memory cache, which `apply()`
 * keeps in sync with the state file.
 *
 * @param exec - tool execution request; `exec.name` is the tool being called and
 *   `exec.agent` identifies the session that is calling. `exec.signal` carries the
 *   turn identity used to lock the choice for the whole turn.
 * @param lookupMode - (exec) => active mode id for that turn, or null.
 *   Synchronous. Production passes `modeForTurn` (turn-locked); `cachedGuardMode`
 *   is the underlying live read, used directly by tests.
 * @returns undefined to allow, or a reason string to deny.
 */
export function agentToolGuard(roster, lookupMode) {
  const owned = agentToolNames(roster)
  // Every id the roster knows. Used below to recognise a mode that refers to an
  // agent which no longer exists.
  const knownIds = new Set(roster.map((e) => (e && typeof e.id === 'string' ? e.id : '')).filter((x) => x !== ''))
  const activeNameOf = (id) => {
    const found = roster.find((e) => e.id === id)
    return found ? found.name : id
  }
  // Diagnostics for the one blind spot this design has: if the execution
  // carries no session identity, the gate cannot tell "this session chose
  // nothing" from "we cannot tell which session this is", and it fails open.
  // That is the right default (never block a legitimate call), but it must be
  // VISIBLE — otherwise a mode that silently stopped applying would look like
  // the plugin doing nothing. One line per tool name, not per call.
  const seen = new Set()
  let sawStale = false
  // Same as above: "cannot serve as executor because the recipe is missing" is also logged once.
  let sawUnusable = false
  // Which tools were allowed through (logged once each) — used to tell
  // "the model never called" apart from "it called but failed elsewhere".
  const allowedSeen = new Set()
  return (exec) => {
    try {
      const name = exec && typeof exec.name === 'string' ? exec.name : ''
      const entry = owned.get(name)
      if (!entry) return undefined
      // The execution's own agent identifies the session that is calling.
      const key = sessionKeyOf(exec)
      if (key === null && !seen.has(name)) {
        seen.add(name)
        diagnose(`gate: ${name} call carries no session identity (allowed as unset) \u2014 if the mode seems not to apply, check here first`)
      }
      const active = lookupMode(exec)
      // No default executor: plain conversation, explicit requests go through.
      if (active === null || active === undefined) return undefined
      // A mode id that is no longer in the roster is NOT a default executor.
      //
      // Reachable by the workflow the roster file itself invites: agents.json is
      // user-editable, so deleting an agent (or renaming its id) leaves every
      // session that had chosen it holding a mode that resolves to nothing. The
      // prompt section already renders that as "unset" (`entryForCached` ->
      // null). The gate MUST agree: otherwise the model is told "no executor,
      // just talk", while every explicit "use Claude Code" is refused with a
      // reason naming an agent the section just said does not exist. Treat it
      // exactly as unset.
      if (!knownIds.has(active)) {
        if (!sawStale) {
          sawStale = true
          diagnose(`gate: the session\u2019s recorded default executor "${active}" is not in the roster (allowed as unset) \u2014 usually it was deleted from agents.json`)
        }
        return undefined
      }
      // Same rule as entryForCached / scanAgents: a needsRecipe member has no
      // tool and cannot be the default executor. Its id is still in the roster,
      // so the "not in the roster" check above cannot catch it — it must be
      // judged separately, or the three readers would answer the same question
      // differently.
      const activeEntry = roster.find((e) => e.id === active)
      if (activeEntry && activeEntry.needsRecipe === true) {
        if (!sawUnusable) {
          sawUnusable = true
          diagnose(`gate: the default executor "${activeNameOf(active)}" has no launch recipe (no tool exists) \u2014 allowed as unset to avoid locking out every other agent`)
        }
        return undefined
      }
      // One more "no tool" case: the roster HAS a recipe, but **registration
      // skipped it** — the launch script referenced by the recipe does not exist
      // on this machine (real-machine diagnosis 2026-10-24 was exactly this:
      // the whole zcode-clis\bin directory was missing, and all 10 entries'
      // *.ps1 files with it).
      //
      // Such an entry has needsRecipe === false (it really does have a recipe),
      // so the allowance above cannot catch it. The result is the user's
      // "cannot converse": the session's chosen qwen has no tool, yet the gate
      // insists "please use Qwen Code's tool instead" — and that tool does not
      // exist. Nothing could be called at all.
      //
      // The criterion prefers **configuration facts** (whether the scripts the
      // recipe references exist): it depends on no global state and holds even
      // when this function is tested alone; the registered set serves only as a
      // second check, and only once it has content.
      const toolNameOf = (e) => (e && e.tool) || ('cli_' + (e && e.id) + '_direct')
      const refsMissing = activeEntry && activeEntry.launch ? launchMissingRefs(activeEntry.launch) : []
      const notRegistered = REGISTERED_LAUNCH_TOOLS.size > 0
        && activeEntry
        && activeEntry.launch
        && !REGISTERED_LAUNCH_TOOLS.has(toolNameOf(activeEntry))
      if (activeEntry && (refsMissing.length > 0 || notRegistered)) {
        if (!sawUnusable) {
          sawUnusable = true
          diagnose(`gate: the default executor "${activeNameOf(active)}" has no usable tool`
            + (refsMissing.length ? ` (recipe-referenced ${refsMissing.join(', ')} missing on this machine)` : ' (registration did not succeed)')
            + ' \u2014 allowed as unset to avoid locking out every other agent')
        }
        return undefined
      }
      if (active === entry.id) {
        // Allowances get a log line too (once per tool name).
        //
        // This is the only evidence of "did the model actually try to call": it
        // called, the gate allowed, but no "call" line follows → the failure
        // happened before execute (host layer); it never called → this line
        // does not exist. The 2026-10-26 report had neither, proving the model
        // never even tried.
        if (!allowedSeen.has(entry.id)) {
          allowedSeen.add(entry.id)
          diagnose(`gate: allowing ${name} (the current executor "${activeNameOf(active)}" is it)`)
        }
        return undefined
      }
      const activeName = activeNameOf(active)
      return `The current default executor is "${activeName}", not "${entry.name}". Use ${activeName}\u2019s tool for this task; unless the user explicitly asks, do not call ${entry.name}.`
    } catch {
      // A guard that throws must never block the turn; fail open.
      return undefined
    }
  }
}

/**
 * The agent tool names **actually registered** in this process.
 *
 * The gate needs this rather than re-deriving it from configuration: when the
 * roster HAS a recipe but the launch scripts it references do not exist on this
 * machine, registerLaunchTools skips the registration; if the gate still treated
 * it as "has a tool", the session would be locked up (the real-machine "cannot
 * converse" came from exactly this).
 */
const REGISTERED_LAUNCH_TOOLS = new Set()
/** This plugin's own version (read from package.json; also holds inside node_modules). */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch { return 'unknown' }
})()

/**
 * Does this launcher exist on this machine?
 *
 * Absolute path → stat the file directly; bare name → look on PATH first, then
 * in the "managed directory" (cliBinDir). The probing layer and the managed
 * directory must use the same judgment, or you get the self-contradiction
 * "the prober found it, but this says not installed" — which makes a perfectly
 * usable entry vanish into thin air.
 */
function launchPresent(bin) {
  if (typeof bin !== 'string' || bin.trim() === '') return false
  if (path.isAbsolute(bin)) return existsSync(bin)
  return Boolean(resolveOnPath(bin, process.env) || resolveInDir(bin, cliBinDir(), process.env))
}

/**
 * "File-like" references inside a recipe's argv (after expanding `{cliDir}`).
 *
 * Why this exists: when `launch.bin` is `powershell.exe`, it can be found on any
 * Windows machine, so "this recipe can run" evaluates to true — but the
 * `codex-zcode.ps1` that actually gets executed may not exist at all. That is
 * exactly what the real-machine diagnostic report (2026-10-22) showed: the tool
 * registered successfully, the list showed it, and the user got an error on click.
 *
 * Two "don't cause collateral damage" rules:
 *   1. Expand placeholders like `{cliDir}/x.ps1` BEFORE judging — checking files
 *      against the raw template never finds anything, and would misjudge good
 *      recipes as broken and overwrite them.
 *   2. Relative paths (`./x.ps1`, `sub\x.ps1`) are exempt — relative to what is
 *      unclear, so better to let them pass.
 */
function launchRefTokens(launch) {
  const out = []
  if (!launch || !Array.isArray(launch.argv)) return out
  for (const raw of launch.argv) {
    if (typeof raw !== 'string' || raw === '') continue
    let t = raw
    try { t = expandLauncherToken(raw) } catch { t = raw }
    if (t.includes('{')) continue // unexpanded placeholder remains → not a pure file reference
    if (!/\.(ps1|cmd|bat|exe|sh|bash|mjs|cjs|js)$/i.test(t)) continue
    const hasSep = /[\\/]/.test(t)
    if (hasSep && !path.isAbsolute(t)) continue // relative path: not judged
    out.push(t)
  }
  return out
}

/** Which files referenced by the recipe cannot be found on this machine. */
function launchMissingRefs(launch) {
  return launchRefTokens(launch).filter((t) => !launchPresent(t))
}

function diagnose(line) {
  try {
    const override = process.env.DSH_AGENT_PICKER_LOG
    const file = (typeof override === 'string' && override.trim() !== '')
      ? override.trim()
      : path.join(dshHome(), 'agent-picker.log')
    const stamp = new Date().toISOString()
    // **Synchronous** append, not fire-and-forget.
    //
    // Async appendFile briefly holds a file handle — usually harmless, but any
    // "delete DSH_HOME" action (test-suite cleanup of temp dirs, the user
    // resetting plugin state) collides with EPERM, and on Windows rmSync's
    // maxRetries does not help with this EPERM: undeletable is undeletable.
    // A boot writes only a dozen or so lines at ~100+ bytes each; the sync
    // write costs nothing worth counting.
    appendFileSync(file, `[${stamp}] ${line}\n`, 'utf8')
  } catch { /* ignore */ }
  try { console.log('[zcode-agent-picker] ' + line) } catch { /* ignore */ }
}

/**
 * Register executor tools for every roster entry that declares an inline
 * `launch` recipe. Entries carrying `tool` are skipped on purpose: that tool
 * belongs to another plugin, and shadowing a registered name is a bug.
 *
 * Never throws — a bad recipe degrades to "this one agent is not callable".
 */
function registerLaunchTools(ctx, roster) {
  const disposers = []
  diagnose(`registerLaunchTools: roster=${Array.isArray(roster) ? roster.length : 'not-array'} entries`)
  if (!ctx || typeof ctx.tools?.register !== 'function') {
    diagnose('registerLaunchTools: aborting — ctx.tools.register is not a function')
    return () => {}
  }
  const taken = ctx.tools.registeredNames instanceof Set ? ctx.tools.registeredNames : null
  diagnose(`registerLaunchTools: registeredNames visible=${taken !== null}${taken ? ' existing=' + taken.size : ''}`)

  for (const entry of roster) {
    if (!entry.launch) {
      diagnose(`  skip ${entry.id}: no launch recipe (borrowing ${entry.tool})`)
      continue
    }
    // The launch scripts referenced by the recipe do not exist on this machine →
    // **do not register this tool**.
    //
    // Real-machine diagnosis (2026-10-24): on that machine the whole
    // C:\Users\<user>\zcode-clis\bin directory was missing, and every one of the
    // roster's 10 entries had a launch like
    //   powershell.exe -File qwen-zcode.ps1 …
    // The old check only looked at launch.bin (powershell.exe, always present),
    // so all 11 tools registered successfully — the user picked qwen in the
    // list, the gate allowed it, and the call was guaranteed to fail with
    // "qwen-zcode.ps1 does not exist". The most frustrating failure mode:
    // clickable, but guaranteed to break.
    //
    // Better "not selectable" than a button that always explodes.
    const missingRefs = launchMissingRefs(entry.launch)
    if (missingRefs.length > 0) {
      diagnose(`  skip ${entry.id}: recipe-referenced ${missingRefs.join(', ')} missing on this machine — registering would only guarantee errors`)
      continue
    }
    const toolName = entry.tool || ('cli_' + entry.id + LAUNCH_TOOL_SUFFIX)
    if (taken !== null && taken.has(toolName)) {
      // A taken name = the tool **already exists** (provided by another plugin,
      // e.g. zcode-sub-cli's cli_claude_direct). So it counts as "has a tool",
      // and the gate must not allow it through on the grounds of "we didn't
      // register it".
      REGISTERED_LAUNCH_TOOLS.add(toolName)
      diagnose(`  skip ${entry.name}: tool name ${toolName} already taken (treated as available; the gate still governs it)`)
      continue
    }
    try {
      diagnose(`  registering ${toolName} ...`)
      const registered = ctx.tools.register(defineTool({
        name: toolName,
        description: [
          `Run one self-contained task through ${entry.name} and return its output.`,
          `${entry.name} is an external agent system; it cannot see this conversation\u2019s context, so the task must be complete and self-contained.`,
          `Use it when the local agent mode picker has set ${entry.name} as the default executor.`,
          // State the argument convention explicitly. Every agent-backed tool in
          // this deployment uses prompt+description (that is what zcode-sub-cli's
          // cli_claude_direct / cli_codex_direct take), and a mode switch must
          // never leave the model guessing parameter names — a wrong guess burns
          // a whole turn and shows up to the user as a failed call.
          'Parameter convention: put the task body in `prompt`, plus a 3-5 word `description` as the title. Uniform across all agent tools.',
          entry.note ? `Note: ${entry.note}` : '',
        ].filter(Boolean).join('\n'),
        parameters: {
          // `prompt` is the canonical name. It is intentionally NOT schema-required
          // so that a call using the legacy alias `task` still reaches execute()
          // instead of failing validation — validation failure and a clear error
          // message cost the same turn, but only the latter explains itself.
          prompt: { type: 'string', description: 'The self-contained task body (the user message body goes here).' },
          description: { type: 'string', description: 'A short title for this call (3-5 words), shown in the UI.' },
          task: { type: 'string', description: '(Compatibility alias) same as prompt; provide one of the two.' },
          model: { type: 'string', description: `Optional: override the model ${entry.name} uses for this run.` },
          permission: { type: 'string', description: 'Optional: permission tier (e.g. read-only / danger-full-access).' },
          image: { type: 'string', description: 'Optional: path of an image file to hand to it. Only effective for members whose CLI supports images (currently only Codex); other members ignore it.' },
          workspace: { type: 'string', description: 'Optional: working directory for the external agent.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const a = args || {}
          const pick = (v) => (typeof v === 'string' && v !== '' ? v : '')
          const prompt = pick(a.prompt) || pick(a.task)
          if (prompt === '') {
            return {
              agent: entry.id,
              name: entry.name,
              ok: false,
              error: `Missing task body: put the content into the prompt parameter (compatibility alias: task). There is no task to execute this time.`,
            }
          }
          // One line before and one line after each call — this blank took six
          // whole rounds of investigation to fill.
          //
          // agent-picker.log used to record only "what was registered"; whether
          // **a call succeeded or failed, what the process exit code was, what
          // stderr said — not one word**. So a real-machine report could prove
          // "the plugin works as designed" but never "what happened after the
          // click", and every round of debugging was guesswork.
          //
          // The body is NOT logged (it can be long, and it can be private) —
          // only its length and the final argv.
          const t0 = Date.now()
          try {
            diagnose(`call ${entry.id}: ${entry.launch.bin} \u00b7 body ${prompt.length} chars`
              + (a.model ? ' \u00b7 model=' + a.model : '')
              + (a.permission ? ' \u00b7 permission=' + a.permission : ''))
          } catch { /* ignore */ }
          const result = await runLaunch(ctx, entry.launch, {
            task: prompt,
            model: pick(a.model),
            permission: pick(a.permission),
            image: pick(a.image),
            workspace: pick(a.workspace),
            signal: exec && exec.signal,
          })
          try {
            const ms = Date.now() - t0
            const err = typeof result?.error === 'string' ? result.error : ''
            const se = typeof result?.stderr === 'string' ? result.stderr.trim() : ''
            const so = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
            diagnose(`return ${entry.id}: ok=${result && result.ok === true}`
              + (typeof result?.exitCode === 'number' ? ' exit=' + result.exitCode : '')
              + ' took=' + ms + 'ms'
              + (err ? ' \u00b7 error=' + err.slice(0, 300).replace(/\s+/g, ' ') : '')
              + (se && (result?.ok !== true) ? ' \u00b7 stderr=' + se.slice(0, 300).replace(/\s+/g, ' ') : '')
              // On failure, **stdout gets logged too**.
              //
              // Lesson of 2026-10-29: that codex failure left only stderr's
              // "Reading additional input from stdin...", while what it really
              // wanted to say was most likely on stdout — logging half of it
              // leaves someone guessing from half a sentence.
              + (so && (result?.ok !== true) ? ' \u00b7 stdout=' + so.slice(0, 300).replace(/\s+/g, ' ') : ''))
            // On failure, also log the **expanded argv** (body replaced by a placeholder).
            //
            // This is the only hard evidence for judging "argument order/values
            // correct": what `-p {permflags} {task}` expanded into, whether empty
            // arguments slipped through, whether flags are spelled right — all
            // visible at a glance. Otherwise you stare at the four characters
            // "failed" and guess.
            if (result?.ok !== true && Array.isArray(result?.argv)) {
              const shown = result.argv.map((t) => {
                const s = String(t)
                if (s === prompt) return '<body>'
                return s.length > 60 ? s.slice(0, 60) + '\u2026' : s
              })
              diagnose(`  argv ${entry.id}: ${JSON.stringify(shown)}`)
            }
          } catch { /* ignore */ }
          // Record this call's outcome: success clears the mark; something like
          // "program not found" gets noted for the next scan. This is the only
          // remedy for a dangling shim — the probing stage cannot catch it.
          await noteLaunchOutcome(
            entry.id,
            result && result.ok === true,
            looksLikeMissing(result && result.error, result && result.stderr),
          )
          // ⚠ The object returned to the host must have argv **removed**.
          //
          // argv exists for the log (to judge argument assembly on failure), but
          // its last element IS the task body. Returning it verbatim hands the
          // user's message back to the model a second time: the result doubles
          // in size and the model reads the same content twice. Caught during a
          // self-check — the first cut in 0.5.5 really did miss it.
          const { argv: _argvForLog, ...visible } = result
          return { agent: entry.id, name: entry.name, ...visible }
        },
      }))
      disposers.push(registered)
      // Recorded into the "actually registered" set — the gate relies on it to
      // know whether the chosen executor really has a tool.
      REGISTERED_LAUNCH_TOOLS.add(toolName)
      const nowTaken = ctx.tools.registeredNames instanceof Set ? ctx.tools.registeredNames.has(toolName) : null
      diagnose(`  registered ${toolName} -> ${entry.name}; registeredNames now contains it=${nowTaken}; disposer=${typeof registered}`)
    } catch (error) {
      diagnose(`  registering ${entry.name} failed: ${error && error.stack ? error.stack : String(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
    }
    // After unload these names no longer mean "has a tool", otherwise the gate
    // misjudges after a reload.
    for (const entry of roster) {
      try { REGISTERED_LAUNCH_TOOLS.delete((entry && entry.tool) || ('cli_' + (entry && entry.id) + '_direct')) } catch { /* ignore */ }
    }
  }
}

/**
 * SYNCHRONOUS roster read, for the boot path.
 *
 * Why this exists (verified the hard way, from the diagnostic log):
 *   `cannot get required service "tools" in inactive context`
 * The executor effect is created and then torn down again moments later during
 * boot. Registering from a `readRoster().then(...)` callback therefore ran
 * AFTER that ctx went inactive: `ctx.tools.register()` returned a disposer and
 * logged success, but the definition landed in a dead context, so the agent's
 * registry view never contained the tool and every call failed with
 *   unknown tool "cli_openclaw_direct"
 *
 * The fix is to finish registration inside `apply()`, with no await in between.
 * `tools.guard()` survives the async path (it is context-independent), which is
 * why the guard reported success while the tool did not — that asymmetry was the
 * clue. Reading a small local JSON synchronously at boot is the right trade;
 * the API-facing `readRoster()` below stays async and authoritative.
 */
/**
 * The CONVENTION DIRECTORY: drop-in agent recipes.
 *
 * Kept next to the roster under `$DSH_HOME` so it follows the zcode install rather
 * than a fixed drive letter, and so two profiles on one machine do not share it
 * by accident. Anyone shipping an agent writes one `*.agent.json` here instead
 * of asking the user to edit a roster or a shell script.
 */
export function conventionDir() {
  return path.join(dshHome(), 'agent-picker.d')
}

/**
 * Layer the CONVENTION DIRECTORY on top of the roster.
 *
 * Any installer, script or sibling plugin can drop one self-describing file per
 * agent into:
 *
 *     $DSH_HOME/agent-picker.d/*.agent.json
 *
 * and the agent shows up without this plugin knowing anything about it. That is
 * the whole point: the picker stays generic, and whoever ships an agent owns its
 * recipe. Shape — same fields as a roster entry:
 *
 *     { "id": "my-agent", "name": "My Agent", "bin": "my-agent.ps1",
 *       "argv": ["-File", "{cliDir}/my-agent.ps1", "{task}"], "kind": "task" }
 *
 * A bare `bin`/`argv` filename is resolved against `cliBinDir()` by
 * `expandLauncherToken`, so a drop-in file stays machine-independent.
 *
 * Precedence: the roster still wins by id — an operator's hand-written entry is
 * never overridden by a drop-in file. Broken files are skipped individually and
 * reported, never fatal: one bad drop-in must not take the picker down.
 */
function loadConventionEntries() {
  const dir = conventionDir()
  let names
  try {
    if (!existsSync(dir)) return []
    names = readdirSync(dir).filter((f) => /\.agent\.json$/i.test(f))
  } catch (error) {
    console.warn('[zcode-agent-picker] convention dir unreadable (' + dir + '):', error)
    return []
  }
  const out = []
  for (const n of names) {
    const file = path.join(dir, n)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      // Accept a single entry or an { agents: [...] } wrapper.
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.agents) ? parsed.agents : [parsed])
      for (const item of list) {
        const entry = normalizeEntry(item)
        if (entry) { entry.__from = 'convention:' + n; out.push(entry) }
        else console.warn('[zcode-agent-picker] convention file ' + n + ' has an unusable entry (needs id + name)')
      }
    } catch (error) {
      console.warn('[zcode-agent-picker] convention file ' + n + ' skipped:', String(error && error.message))
    }
  }
  if (out.length > 0) {
    console.log('[zcode-agent-picker] conventional directory merged in ' + out.length + ' entries: ' + out.map((e) => e.id).join(', '))
  }
  return out
}

/**
 * Layer agent DISCOVERY on top of the roster.
 *
 * The roster is an override layer, not the whole story: an agent that is merely
 * INSTALLED on this machine should show up without anyone hand-writing a recipe.
 * Precedence, highest first:
 *
 *   1. the roster (packaged template or the user's own file)  <- wins, by id
 *   2. the convention dir ($DSH_HOME/agent-picker.d)          <- drop-in recipes
 *   3. discovered agents (PATH + cliBinDir)                   <- fills the gaps
 *   4. FALLBACK_ROSTER                                        <- already applied
 *
 * Nothing discovered may shadow a rostered id, so a hand-written recipe (with
 * its endpoint env, image argument, longer timeout…) always keeps control.
 *
 * An entry surfaced here is marked `available` only when it is actually
 * USABLE: the command resolved AND every env var it needs is present AND it
 * needs no background service. Otherwise it still appears, with a note saying
 * what is missing — a picker that silently hides a just-installed agent is
 * worse than one that shows it as "needs configuration".
 *
 * Escape hatch: `DSH_AGENT_PICKER_DISCOVER=0` turns BOTH extra layers off, which
 * is what the offline suites use so they keep asserting on the roster alone.
 */
function mergeDiscovered(roster) {
  const flag = process.env.DSH_AGENT_PICKER_DISCOVER
  if (flag === '0' || flag === 'false') return roster

  // --- layer 2: convention dir ---
  let merged = roster
  try {
    const conv = loadConventionEntries()
    if (conv.length > 0) {
      const have = new Set(merged.map((e) => e.id))
      merged = merged.concat(conv.filter((e) => !have.has(e.id)))
    }
  } catch (error) {
    console.warn('[zcode-agent-picker] convention layer failed (roster used):', error)
  }

  // --- layer 3: discovery ---
  let found
  try {
    // Where to look beyond PATH. cliBinDir is where managed wrappers live and is
    // NOT on PATH on this deployment (without it, codex is invisible). The
    // `~/.local/bin` convention is where pipx/uv and several agent installers
    // drop their launchers (aider lives there here) — also not on PATH.
    found = discoverAgents(process.env, [
      cliBinDir(),
      path.join(os.homedir(), '.local', 'bin'),
    ])
  } catch (error) {
    console.warn('[zcode-agent-picker] agent discovery failed (roster used as-is):', error)
    return merged
  }
  const have = new Set(merged.map((e) => e.id))
  // Whether the roster entry's launch target really exists on this machine → use the module-level
  // launchPresent / launchMissingRefs (tool registration below uses the same judgment, so no
  // second local copy may be written)
  const healed = []
  const extra = []
  for (const d of found) {
    // Anything that actually EXISTS on this machine goes into the list — including
    // the agents we can recognise but have no verified launch recipe for. Skipping
    // those (`continue` on empty argv) is why a machine could have Cursor installed
    // and show nothing at all: the user could not even tell it had been detected.
    if (!d.found || !d.exe) continue
    const hasRecipe = Array.isArray(d.argv) && d.argv.length > 0
    if (have.has(d.id)) {
      // The roster wins — but only while it **can actually run on this machine**.
      //
      // This is the root cause of 0.5.0 failing on a real machine: that machine ran the new
      // version but still had an agent-picker.agents.json left over from the 0.4.1 era — claude
      // was a "borrowed entry" in it (no launch), and the other members pointed at the author
      // machine's *.ps1 wrappers (nonexistent locally). The roster had top priority, so those
      // entries stayed broken forever: the log kept saying "skip claude: no launch recipe",
      // while auto-discovery had already found a working claude / qwen that this line threw away.
      //
      // The rule now:
      //   · If the roster entry can run (launch exists AND its target really is there) → leave it
      //     completely alone. The user may have deliberately pointed it at their own wrapper
      //     (say that codex script with CODEX_HOME stuffed in) — such customization must not be
      //     overwritten.
      //   · If the roster entry cannot run (no launch / an absolute path to something this machine
      //     does not have) AND discovery has a usable recipe → fill it in with the discovered
      //     recipe, and explain it in the note.
      //
      // Note: **descriptive fields are refreshed too**. Once only launch was patched, and the list
      // still showed the author machine's old copy ("local CLI 2.1.278 · via the DeepSeek endpoint")
      // and the old-style "Good at: … (web ✅ images ✅ docs ✅ speech ✅)". The user's own words:
      // "detect what agents exist on someone else's computer and write the names in automatically —
      // the intros work the same way" — name and intro alike belong to the "fill from this machine's
      // facts" part.
      const existing = merged.find((e) => e.id === d.id)
      // "Can this roster entry actually run on this machine" — launch.bin alone is not enough.
      //
      // Real-machine diagnostic report (2026-10-22, another computer): in that 0.4.x roster,
      // entries like codex/qwen had launches like
      //   powershell.exe -NoProfile -ExecutionPolicy Bypass -File codex-zcode.ps1 …
      // launch.bin is powershell.exe — **present on every Windows machine**, so it judged "can
      // run" and self-healing never triggered; but the codex-zcode.ps1 that actually executes
      // did not exist on that machine at all, and the call failed immediately. What the user saw:
      // "the tool is clearly registered, yet clicking it errors".
      //
      // So the scripts/executables referenced inside argv must be checked too.
      //
      // Two "don't cause collateral damage" rules (thought up during a self-check):
      //   1. Expand placeholders like `{cliDir}/x-zcode.ps1` **first**, then judge — checking files
      //      against the raw template never finds anything, and would misjudge good recipes as
      //      broken and overwrite them.
      //   2. Relative paths (`./x.ps1`, `sub\x.ps1`) are exempt — relative to what is unclear;
      //      better to let it pass than to overwrite the user's configuration on a guess.
      //      Only "absolute paths" and "bare filenames with a script/executable extension" are judged.
      const rosterWorks = existing && existing.launch
        ? launchPresent(existing.launch.bin) && launchMissingRefs(existing.launch).length === 0
        : false
      if (existing && hasRecipe && !rosterWorks) {
        healed.push(d.id)
        // Record the final post-heal recipe — the second thing real-machine reports miss most:
        // you learn "it was fixed" but cannot see what it was fixed INTO (which bin, what argv).
        // The next report only needs to paste this line to judge "was it configured right", no
        // guessing required.
        try {
          const finalArgv = d.argv.includes('{task}') ? d.argv.slice() : d.argv.concat(['{task}'])
          diagnose(`  healed ${d.id} -> ${d.exe} ${JSON.stringify(finalArgv)}`)
        } catch { /* ignore */ }
        merged = merged.map((e) => (e.id !== d.id ? e : {
          ...e,
          name: d.name || e.name,
          bin: d.exe,
          // ⚠ Must go through parseLaunch to fill in the defaults — never hand-assemble a
          // "half-finished" object.
          //
          // Real-machine evidence (2026-10-29 04:36:43): the healed claude errored on its very
          // first call with
          //   subprocess graceMs must be a positive finite number
          // because only bin/argv/permFlags were written here; graceMs/timeoutMs/maxBytes were
          // all undefined, and the host's spawn hard-validates graceMs — it refuses to start.
          //
          // This bug existed since 0.5.x but never surfaced: the author's own 11 entries all had
          // hand-written recipes (through parseLaunch, defaults complete); only machines where
          // "the roster row cannot run and auto-discovery takes over" hit it — i.e. claude on
          // that other machine.
          launch: parseLaunch({
            bin: d.exe,
            argv: d.argv.includes('{task}') ? d.argv.slice() : d.argv.concat(['{task}']),
            permFlags: d.permFlags || undefined,
            defaultPermFlags: d.defaultPermFlags || undefined,
          }),
          needsRecipe: false,
          kind: d.kind === 'chat' ? 'chat' : 'task',
          // The intro follows the catalog (old rosters never had a desc field at all)
          desc: d.desc || e.desc,
          // This row in the UI is **always visible**, while the "intro" only shows when expanded —
          // so put the intro right here, filling "name + intro" together from this machine's facts;
          // status moves down into the note line.
          expertise: d.desc || (d.ready ? 'auto-discovered, ready to use' : 'installed, needs setup'),
          note: 'auto-discovered (' + d.exe + '); the roster entry cannot run on this machine \u2014 replaced with the detected recipe'
            + (d.permNote ? '; ' + d.permNote : '')
            + (d.ready ? '' : (d.missingEnv && d.missingEnv.length ? '; missing env vars: ' + d.missingEnv.join(', ') : '; needs setup')),
        }))
      } else if (existing && d.desc && !existing.desc) {
        // Not healed (it can run here) but still add an intro: old rosters have no desc field.
        // Purely additive — it never overwrites copy the user wrote themselves.
        merged = merged.map((e) => (e.id !== d.id ? e : { ...e, desc: d.desc }))
      }
      continue
    }
    const missing = d.missingEnv ? d.missingEnv.join(', ') : ''
    const noteParts = ['auto-discovered (' + d.exe + (d.exeFrom === 'cliDir' ? ', from cliBinDir' : '') + ')']
    // When a permission tier has no effect here, say so — otherwise the UI is lying
    if (d.permNote) noteParts.push(d.permNote)
    if (!hasRecipe) {
      noteParts.push('CLI recognized, but no launch recipe yet \u2014 add a launch entry via the conventional directory or the roster and it becomes callable')
    } else if (!d.ready) {
      if (missing) noteParts.push('missing env vars: ' + missing)
      if (d.needsService) noteParts.push('also needs: ' + d.needsService)
    }
    extra.push({
      id: d.id,
      name: d.name,
      tool: 'cli_' + d.id + '_direct',
      bin: d.exe,
      // Without a recipe it is not callable, so this must be false — it lands in the
      // "Installable" section with a "launch recipe needed" note, instead of pretending to work.
      available: hasRecipe && d.ready,
      kind: d.kind === 'chat' ? 'chat' : 'task',
      expertise: d.desc || (hasRecipe
        ? (d.ready ? 'auto-discovered, ready to use' : 'installed, needs setup')
        : 'Detected \u2014 launch recipe needed'),
      note: noteParts.join('; '),
      // The intro comes from the built-in table's desc (looked up, not guessed)
      desc: d.desc || ('Auto-discovered on this machine: ' + d.name + ' (' + d.exe + ').'),
      // No recipe → the frontend should render this as a "guideable to completion" state,
      // not a dead end
      needsRecipe: !hasRecipe,
      launch: hasRecipe
        ? {
          bin: d.exe,
          // Do NOT drop the last element: the builtin argv already ends with
          // `{task}`, and the tokens BEFORE it carry the permission /
          // non-interactive flags. Slicing the tail off silently discarded them,
          // which is how a discovered codex ended up running as `read-only`.
          argv: d.argv.includes('{task}') ? d.argv.slice() : d.argv.concat(['{task}']),
          permFlags: d.permFlags || undefined,
          defaultPermFlags: d.defaultPermFlags || undefined,
        }
        : undefined,
    })
  }
  if (healed.length > 0) {
    // diagnose rather than a bare console.log: console.log only reaches harness.log,
    // while the real-machine diagnostic report collects agent-picker.log — the one
    // line that most needs to be seen would fall outside it.
    diagnose('Healed ' + healed.length + ' roster entries that could not run on this machine using auto-discovered recipes: ' + healed.join(', '))
  }
  if (extra.length === 0) return merged
  const out = merged.concat(extra.map(normalizeEntry).filter(Boolean))
  console.log('[zcode-agent-picker] auto-discovery merged in ' + extra.length + ' entries: ' + extra.map((e) => e.id).join(', '))
  return out
}

function readRosterSync() {
  const target = rosterFile()
  try {
    if (!existsSync(target)) {
      try {
        const seed = readFileSync(packagedRosterFile(), 'utf8')
        mkdirSync(dshHome(), { recursive: true })
        writeFileSync(target, seed, 'utf8')
        console.log('[zcode-agent-picker] seeded roster -> ' + target)
      } catch (error) {
        console.warn('[zcode-agent-picker] roster seed failed (will use fallback):', error)
      }
    }
    return mergeDiscovered(parseRosterText(readFileSync(target, 'utf8')))
  } catch (error) {
    console.warn('[zcode-agent-picker] roster sync read failed, using fallback:', error)
    return mergeDiscovered(FALLBACK_ROSTER)
  }
}

/**
 * Turn one raw roster entry into the shape the rest of the plugin uses.
 *
 * Returns null for an entry that cannot be identified. This is the ONLY place
 * an agent entry is built — the fallback list and every roster file both come
 * through here — so a field added below cannot be missing on one path while
 * present on the other. (It used to be inline in `parseRosterText`, with the
 * fallback returned un-normalized: see the note on `FALLBACK_ROSTER`.)
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return null
  return {
    id: entry.id,
    name: entry.name,
    tool: typeof entry.tool === 'string' ? entry.tool : ('cli_' + entry.id + '_direct'),
    bin: typeof entry.bin === 'string' ? entry.bin : (entry.id + '.cmd'),
    available: entry.available === true,
    note: typeof entry.note === 'string' ? entry.note : '',
    // Capability fields for the menu. `expertise` is the one-line "good at"
    // summary shown under the name; `desc` is the fuller blurb revealed by
    // expanding the row. Both optional — older rosters simply lack them.
    expertise: typeof entry.expertise === 'string' ? entry.expertise : '',
    desc: typeof entry.desc === 'string' ? entry.desc : '',
    // Execution KIND, which decides how the host model treats a user message
    // when this agent is the active executor:
    //   'task' (default) - the message is a self-contained task to delegate.
    //   'chat'           - the message is ordinary speech; the agent's reply
    //                      must be relayed VERBATIM, not summarized.
    // Default to 'task': every agent we shipped before this field existed is
    // a task executor, so an old roster keeps its behaviour exactly.
    kind: entry.kind === 'chat' ? 'chat' : 'task',
    // Inline executor recipe. Only present for agents zcode has no tool for;
    // entries that carry `tool` are executed by whichever plugin owns it.
    // Always normalized (or null), never the raw literal: the launch recipe's
    // defaults are what bound the child's output, so skipping this step is a
    // resource bug, not a cosmetic one.
    launch: parseLaunch(entry.launch),
    // Detected, but a launch recipe we have never verified — the user must add
    // a launch entry before it is truly callable.
    // Only auto-discovery sets this to true (see mergeDiscovered); hand-written
    // rosters default to false, because a hand-written entry either carries a
    // recipe or is borrowing a tool another plugin registered anyway.
    needsRecipe: entry.needsRecipe === true,
  }
}

/**
 * Prune legacy leftovers: delete roster entries whose "launch recipe points at
 * scripts that do not exist on this machine".
 *
 * Why this must happen automatically (the user's own words):
 *   "I want the machine to show what it actually has; the first version's
 *     leftovers should be removed — that was the old version, not what the
 *     current one should look like"
 *
 * Rosters from the 0.4.x era carried 11 entries pointing at the **author's
 * machine** wrappers (`*-zcode.ps1`). The plugin only seeds when the roster file
 * does not exist and never overwrites an existing one — that rule itself is
 * right (it is the user's data), but it meant that after upgrading, the list was
 * still that old edition: 9 entries permanently "skipped", and non-agent
 * entries like image/video generators squatting in the list. A hint alone is not
 * enough; this has to clean up after itself.
 *
 * Three safety boundaries:
 *   1. Only entries **proven unrunnable** are deleted (a script referenced in
 *      argv does not exist on this machine). "Borrowed" entries without any
 *      launch are never touched — their tool may be provided by another plugin.
 *   2. The original file is **fully backed up** before deletion
 *      (`<roster>.legacy-<timestamp>.bak`).
 *   3. If there is nothing to delete, no file is written (on the author's
 *      machine, where everything runs, not one byte is touched).
 *
 * After deletion the discovery layer re-adds the CLIs that really exist here
 * (using the catalog's copy), so the user sees "what this machine has", not
 * "the previous version's inventory".
 */
function pruneLegacyRoster() {
  const target = rosterFile()
  try {
    if (!existsSync(target)) return { dropped: [] }
    const raw = readFileSync(target, 'utf8')
    const text = String(raw ?? '').replace(/^\uFEFF/, '')
    let doc
    try { doc = JSON.parse(text) } catch { return { dropped: [] } }
    const list = doc && Array.isArray(doc.agents) ? doc.agents : null
    if (list === null || list.length === 0) return { dropped: [] }

    const kept = []
    const dropped = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') { kept.push(entry); continue }
      // Escape hatch: an entry marked "keep": true is never auto-cleaned.
      //
      // Someone may write the recipe first and install the CLI later (especially
      // for the {cliDir}-pointing ones); auto-deleting such a half-finished entry
      // throws their work away. An explicit "don't touch me" switch beats making
      // them dig through the .bak.
      if (entry.keep === true) { kept.push(entry); continue }
      const missing = entry.launch ? launchMissingRefs(entry.launch) : []
      if (missing.length > 0) { dropped.push({ id: String(entry.id ?? '?'), missing }); continue }
      kept.push(entry)
    }
    if (dropped.length === 0) return { dropped: [] }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const backup = target + '.legacy-' + stamp + '.bak'
    try { writeFileSync(backup, raw, 'utf8') } catch { /* if the backup fails, do not delete */ return { dropped: [], backupFailed: true } }
    const out = Object.assign({}, doc, { agents: kept })
    writeFileSync(target, JSON.stringify(out, null, 2), 'utf8')
    diagnose(`prune legacy roster: removed ${dropped.length} entries that cannot run on this machine (${dropped.map((d) => d.id).join(', ')}); original file backed up to ${backup}`)
    return { dropped: dropped.map((d) => d.id), backup }
  } catch (error) {
    diagnose(`prune legacy roster failed (skipped; harmless): ${error && error.message ? error.message : String(error)}`)
    return { dropped: [] }
  }
}

/**
 * Parse + normalize a roster document; shared by the sync and async readers.
 *
 * Exported so the offline verification can assert on the fallback path
 * directly — the bug this guards against (fallback entries skipping
 * normalization, and so running with an unbounded output cap) is invisible on
 * the happy path where `agents.json` parses correctly.
 */
export function parseRosterText(raw) {
  try {
    // Strip the UTF-8 BOM first.
    //
    // This is far too common on Windows: a UTF-8 file saved with Notepad, or
    // written by PowerShell's Out-File / Set-Content, starts with U+FEFF.
    // JSON.parse throws a SyntaxError on it, so the **entire roster is
    // discarded** and the plugin falls back to the empty factory roster —
    // the user sees "I clearly wrote a roster, but the plugin acts like there
    // is none".
    // (My own verification script tripped on this: it wrote a mock roster with
    // Out-File and the plugin failed to parse it.)
    const text = String(raw ?? '').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    const list = parsed && Array.isArray(parsed.agents) ? parsed.agents : null
    if (list === null) return FALLBACK_ROSTER
    const clean = list.map(normalizeEntry).filter(Boolean)
    return clean.length > 0 ? clean : FALLBACK_ROSTER
  } catch (error) {
    console.warn('[zcode-agent-picker] roster parse failed, using fallback:', error)
    return FALLBACK_ROSTER
  }
}

/**
 * Read the user roster, seeding it from the packaged template on first run.
 * Never throws: a broken or missing roster degrades to the fallback list.
 */
async function readRoster() {
  const target = rosterFile()
  try {
    if (!(await exists(target))) {
      // First run: seed a copy the user can edit, then use the packaged content.
      try {
        const seed = await readFile(packagedRosterFile(), 'utf8')
        await mkdir(dshHome(), { recursive: true })
        await writeFile(target, seed, 'utf8')
        console.log('[zcode-agent-picker] seeded roster -> ' + target)
      } catch (error) {
        console.warn('[zcode-agent-picker] roster seed failed (will use fallback):', error)
      }
    }
    return mergeDiscovered(parseRosterText(await readFile(target, 'utf8')))
  } catch (error) {
    console.warn('[zcode-agent-picker] roster read failed, using fallback:', error)
    return mergeDiscovered(FALLBACK_ROSTER)
  }
}

/**
 * Turn any of the shapes zcode hands us into a session key.
 *
 * The plugin meets session identity in four different wrappers depending on the
 * call site: a bare id string (the HTTP route), an agent object with `id`
 * (`context.agent` during prompt assembly), a context carrying `agent`, and a
 * tool execution (`exec.agent`). Normalising here keeps every caller honest and
 * gives one answer to "which session is this?".
 *
 * @returns the key, or null when the caller carries no session identity.
 */
export function sessionKeyOf(candidate) {
  let value = candidate
  if (value !== null && typeof value === 'object' && value.agent !== undefined && value.agent !== null) {
    value = value.agent
  }
  if (value !== null && typeof value === 'object') {
    // An agent object carries BOTH its own `id` and its `session`. The browser
    // names a SESSION (`conversation.input.right` hands out `sessionId`), so the
    // session identity is the one that must match. Prefer it, and fall back to
    // `id` for the plain `{ id }` shapes the tests and routes use.
    const session = value.session
    if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id !== '') {
      return session.id
    }
    value = value.id
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Best-effort description of an assembly/execution context, for diagnostics.
 * Reports BOTH candidate identities when they differ, because a mismatch
 * between the agent id and the session id would silently break per-session
 * isolation and is otherwise invisible.
 */
function describeSessionContext(candidate) {
  const raw = candidate !== null && typeof candidate === 'object' && candidate.agent !== undefined
    ? candidate.agent
    : candidate
  if (raw === null || typeof raw !== 'object') return `not-an-object(${typeof raw})`
  const agentId = typeof raw.id === 'string' ? raw.id : '(none)'
  const sessionId = raw.session !== null && typeof raw.session === 'object' && typeof raw.session.id === 'string'
    ? raw.session.id
    : '(none)'
  const chosen = sessionKeyOf(candidate) ?? '(unavailable)'
  return `chosen=${chosen}  agent.id=${agentId}  session.id=${sessionId}` +
    (agentId !== '(none)' && sessionId !== '(none)' && agentId !== sessionId ? '  \u26a0 the two disagree' : '')
}

/** Most recent session choices kept on disk; older ones are pruned. */
const MAX_SESSION_MODES = 200

/**
 * Read the whole state document; never throws.
 *
 * Shape: `{ modes: { "<sessionKey>": { id, at } }, enabled[], disabled[] }`
 *
 * `modes` is keyed by SESSION on purpose. It used to be one global `id`, which
 * meant switching the Agent in one conversation silently switched it in every
 * other conversation — sessions are meant to be independent, so the choice now
 * lives with the session that made it. A legacy global `id` is deliberately
 * dropped: sessions start unset rather than inheriting someone else's choice.
 */
/** Normalise a parsed state document into the canonical shape. Pure. */
function parseStateDocument(parsed) {
  const modes = {}
  const source = parsed && parsed.modes && typeof parsed.modes === 'object' ? parsed.modes : {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    const id = typeof value === 'string' ? value : (value && typeof value.id === 'string' ? value.id : null)
    if (id === null || id === '' || id === 'off') continue
    const at = value && typeof value.at === 'string' && value.at !== '' ? value.at : ''
    modes[key] = { id, at }
  }
  return {
    modes,
    enabled: parsed && Array.isArray(parsed.enabled) ? parsed.enabled.filter((x) => typeof x === 'string') : [],
    // `disabled` records agents the user explicitly removed. Without it the
    // auto-enable rule (available && installed) would silently resurrect a
    // removed agent, making the menu's remove button appear to do nothing.
    disabled: parsed && Array.isArray(parsed.disabled) ? parsed.disabled.filter((x) => typeof x === 'string') : [],
  }
}

async function readState() {
  try {
    return parseStateDocument(JSON.parse(await readFile(stateFile(), 'utf8')))
  } catch {
    return { modes: {}, enabled: [], disabled: [] }
  }
}

/**
 * SYNCHRONOUS state read, for the boot path.
 *
 * The prompt section reads the mode cache on every assembly, and the cache is
 * primed at boot. Loading it through a promise leaves a window where an
 * assembly sees an EMPTY map — and if that effect is torn down before the
 * promise lands (which zcode really does during boot), the cache stays empty
 * forever and EVERY session silently reads as "unset", disabling the mode
 * altogether. Same class of failure as the async tool registration documented in
 * AGENT-TOOLS.md 16.7: on the boot path, promise callbacks run against a context
 * that may already be gone. Read it synchronously instead.
 */
function readStateSync() {
  try {
    return parseStateDocument(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    return { modes: {}, enabled: [], disabled: [] }
  }
}

/**
 * Persist the state document; never throws.
 *
 * ATOMIC on purpose. A plain `writeFile` truncates first and writes second, so
 * an interrupted write (app killed mid-save, which really happened here) leaves
 * a 0-byte file. The plugin tolerates that (readState falls back to defaults),
 * but the user silently loses which agents they had enabled. Writing to a
 * sibling temp file and renaming makes the swap atomic: readers see either the
 * old document or the new one, never a half-written one.
 */
async function writeState(next) {
  const target = stateFile()
  const tmp = target + '.tmp'
  try {
    await mkdir(dshHome(), { recursive: true })
    const modes = {}
    const entries = Object.entries(next && next.modes && typeof next.modes === 'object' ? next.modes : {})
    // Keep only the most recently touched sessions: otherwise a long-lived
    // harness accumulates one entry per conversation, forever.
    entries.sort((a, b) => String((b[1] && b[1].at) || '').localeCompare(String((a[1] && a[1].at) || '')))
    for (const [key, value] of entries.slice(0, MAX_SESSION_MODES)) {
      if (typeof key !== 'string' || key === '') continue
      const id = value && typeof value.id === 'string' ? value.id : null
      if (id === null || id === '' || id === 'off') continue
      modes[key] = {
        id,
        // Treat an empty string as missing: readState yields '' for legacy
        // entries that never carried a timestamp, and keeping that would make
        // the prune order meaningless.
        at: (value && typeof value.at === 'string' && value.at !== '') ? value.at : new Date().toISOString(),
      }
    }
    const body = JSON.stringify({
      modes,
      enabled: Array.isArray(next.enabled) ? next.enabled : [],
      disabled: Array.isArray(next.disabled) ? next.disabled : [],
      at: new Date().toISOString(),
    }, null, 2)
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, target)
    return true
  } catch (error) {
    console.warn('[zcode-agent-picker] state write failed:', error)
    try { await rm(tmp, { force: true }) } catch { /* ignore */ }
    // The failure must be spoken out loud.
    // This used to return nothing at all (success and failure both undefined),
    // leaving callers unable to tell: on a full disk / permission error, this
    // process would run on the new mode (cache already changed) and silently
    // revert after a restart, while the user saw "switch successful". This is
    // the write-side version of "one path has a value, the other has none".
    return false
  }
}

/**
 * Serialize state mutations.
 *
 * Every writer is a read-modify-write over a shared document. Now that the
 * choice is PER SESSION, two conversations can legitimately write at the same
 * moment (two browser tabs, or a switch in one while another loads) — and two
 * overlapping read-modify-write cycles lose one of the updates, silently
 * dropping a session's choice. Node is single-threaded but `await` interleaves,
 * so the fix is an explicit queue: each mutation runs to completion before the
 * next begins.
 */
let stateQueue = Promise.resolve()
function withStateLock(task) {
  const run = stateQueue.then(task, task)
  // Keep the chain alive even when a task rejects (every caller catches).
  stateQueue = run.then(() => undefined, () => undefined)
  return run
}

/** The mode chosen in one session; null when that session has not chosen. */
export async function readMode(sessionKey) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  const state = await readState()
  const hit = state.modes[key]
  return hit ? hit.id : null
}

/**
 * Set (or clear) the mode for ONE session. Never throws.
 *
 * @returns `{ id, persisted }`. `id` is the normalised value that was applied
 *   (null means cleared). `persisted` says whether it actually reached the disk.
 *   Callers MUST consult it before updating the in-memory cache: memory and disk
 *   disagreeing means the switch works until the next restart and then silently
 *   reverts, which the user experiences as "it just forgets my choice".
 */
export function writeMode(sessionKey, id) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return Promise.resolve({ id: null, persisted: false })
  const normalized = id === '' || id === 'off' || id === undefined || id === null ? null : String(id)
  return withStateLock(async () => {
    const state = await readState()
    const modes = { ...state.modes }
    if (normalized === null) delete modes[key]
    else modes[key] = { id: normalized, at: new Date().toISOString() }
    const persisted = await writeState({ modes, enabled: state.enabled, disabled: state.disabled })
    return { id: normalized, persisted }
  })
}

/** Convenience wrapper used by tests/tools. */
export function dshHomePath() {
  return dshHome()
}

/**
 * Build the agent list the UI needs, merging roster data with real state.
 *
 * Precedence (this order matters — getting it wrong made the remove button a
 * no-op): an explicit user decision always wins over the auto-enable rule.
 *  1. id in `disabled`  -> NOT enabled (the user removed it; stay removed)
 *  2. id in `enabled`   -> enabled (the user added it back)
 *  3. roster says available AND the wrapper file exists -> enabled (auto)
 *  4. otherwise         -> not enabled (offered in the "installable" area)
 */
/**
 * Is this member actually runnable on THIS machine?
 *
 * This used to be `exists(path.join(cliBinDir(), entry.bin))` — which only ever
 * looked inside the managed wrapper directory. Two things broke because of that:
 *
 *   - A CLI the user installed themselves (on PATH, e.g. `claude` in
 *     a managed dir) was reported as "not installed", so it never showed
 *     up as usable even though it was right there.
 *   - A discovered entry carries an ABSOLUTE exe path, and joining it onto
 *     cliBinDir produced a nonsense path, so every discovered member was
 *     "not installed" too.
 *
 * So: absolute path → just stat it; bare name → cliBinDir first (managed
 * wrappers live there and are not on PATH), then PATH with PATHEXT semantics.
 */
/**
 * Call-failure memory (the dangling-shim remedy).
 *
 * Background: probing can only see "is the file there". Install a CLI with
 * `npm i -g`, then remove the package, and shims like `claude.cmd` remain while
 * the `xxx.exe` they point at is gone — probing judges "installed", and the
 * user only finds out on click, with "The system cannot find the path specified".
 *
 * zcode's tool runtime has no enumeration interface, so the probing stage
 * cannot verify what sits behind a .cmd (and we do not want to run a pile of
 * --version commands at boot: slow, and they can hang). So we take a step back:
 * **remember it after a failure**, write it into that row's note on the next
 * scan, and clear it automatically the next time a call succeeds.
 *
 * A separate file, not state.json — state has several write sites, and adding a
 * field means touching all of them; this is pure display information and not
 * worth that risk.
 */
function brokenFile() {
  return path.join(dshHome(), 'agent-picker.broken.json')
}

async function readBroken() {
  try {
    const raw = await readFile(brokenFile(), 'utf8')
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

/** After a call finishes, update that table: success clears it; "program gone" gets a note. */
async function noteLaunchOutcome(id, ok, looksMissing) {
  // Serialize: this is "read → modify → write"; two calls failing at once would
  // overwrite each other and drop a record. Reuse the state queue — both are
  // small-file operations with no cross-dependencies.
  return withStateLock(async () => {
    try {
      const map = await readBroken()
      if (ok) {
        if (map[id] === undefined) return
        delete map[id]
      } else if (looksMissing) {
        map[id] = { at: new Date().toISOString(), error: 'Cannot find the executable (the shim may be dangling)' }
      } else {
        return
      }
      await mkdir(dshHome(), { recursive: true })
      await writeFile(brokenFile(), JSON.stringify(map, null, 2), 'utf8')
    } catch { /* if it cannot be recorded, so be it — never affect the tool call itself */ }
  })
}

/**
 * Does this failure look like "the program itself does not exist"?
 *
 * The test must be strict, or it misfires: while an agent does honest work, its
 * stderr can absolutely contain "No such file" / "cannot find the file" (it is
 * complaining about some task-related file that does not exist). That must
 * **not** be recorded as a "dangling shim", or the user sees a baffling warning.
 *
 * So only three signals **unrelated to the task content** are accepted:
 *   ① our own resolution-failure wording (`Cannot find executable …`) — unambiguous;
 *      the Chinese original 找不到可执行文件 is kept so logs from any locale still match;
 *   ② the host spawn layer's ENOENT — also "program does not exist";
 *   ③ Windows' "The system cannot find the path/file specified", and **the whole
 *      output is short** — a real task error usually carries a pile of context
 *      (file names, line numbers, its own troubleshooting hints) and would never
 *      be this short.
 */
function looksLikeMissing(error, stderr) {
  const text = (String(error || '') + '\n' + String(stderr || '')).trim()
  if (text === '') return false
  if (/Cannot find executable|找不到可执行文件/.test(text)) return true
  if (/\bspawn\s+ENOENT\b/i.test(text)) return true
  if (text.length <= 200 && /系统找不到指定的(路径|文件)|cannot find the (file|path) specified/i.test(text)) return true
  return false
}

async function isInstalled(entry, dir) {
  const bin = typeof entry.bin === 'string' ? entry.bin : ''
  if (bin === '') return false
  if (path.isAbsolute(bin)) return exists(bin)
  if (await exists(path.join(dir, bin))) return true
  try {
    if (resolveOnPath(bin, process.env) !== null) return true
    // Use the **same set** of "install locations that are not on PATH" as the
    // probing layer.
    //
    // Without this, the two layers contradict each other: probing says it found
    // claude (in %APPDATA%\npm) while this says "not installed" — the UI then
    // shows "CLI not found" and the new main-list filter hides it. A working
    // entry vanishing into thin air is worse than displaying it wrong.
    for (const d of defaultSearchDirs(process.env)) {
      if (resolveInDir(bin, d, process.env) !== null) return true
    }
    return false
  } catch {
    return false
  }
}

export async function scanAgents(sessionKey) {
  const dir = cliBinDir()
  const roster = await readRoster()
  const state = await readState()
  const enabledSet = new Set(state.enabled)
  const disabledSet = new Set(state.disabled)
  // The active executor is per session: report the one THIS session chose.
  // A mode pointing at a needsRecipe member reports as "unset" — it has no tool
  // to dispatch to, so calling it the default executor would be a lie the gate
  // then enforces by blocking everything else. `entryForCached` and the gate
  // apply the same rule; all three readers have to agree or the two halves of
  // the plugin disagree about what this session is doing.
  const key = sessionKeyOf(sessionKey)
  const chosenId = key !== null && state.modes[key] ? state.modes[key].id : null
  const chosenEntry = chosenId === null ? null : (roster.find((e) => e.id === chosenId) || null)
  // The panel must be able to see "who this session picked" — it must recognize the choice even
  // when the agent is not installed locally (otherwise the user has no way to switch away).
  // So only needsRecipe (no recipe; fundamentally not callable) is filtered out here.
  //
  // Whether "the selected executor has no usable tool" should hard-lock the session is the
  // **gate's** job: it decides based on the registration result and allows accordingly (see
  // agentToolGuard). Nulling `active` at this layer would make the panel show "unset" while
  // disagreeing with what the user actually picked.
  const active = chosenEntry !== null && chosenEntry.needsRecipe === true ? null : chosenId

  const agents = []
  const brokenMap = await readBroken()
  for (const entry of roster) {
    // The launch script referenced by the recipe does not exist → treat the same as "not installed".
    //
    // Otherwise you get a self-contradiction: `bin` (say `qwen-zcode.cmd`) happens to resolve, so it
    // is judged "installed", enters the main list, and can be selected — but the `qwen-zcode.ps1`
    // that the launch actually runs is absent, and registerLaunchTools skips the tool too.
    // Selecting it means selecting an executor with no tool, and the gate then blocks every other
    // agent (that is exactly how the real machine's "cannot converse" happened).
    const missingRefs = launchMissingRefs(entry.launch)
    const installed = missingRefs.length === 0 && await isInstalled(entry, dir)
    // A needsRecipe member is **not callable**: it has no launch recipe, so no tool can be registered.
    //
    // The UI (no "\uFF0B") and the API (/enable returns 409) both block this, but state.json is a
    // user-hand-editable file — that path has no gate. Once such a member enters the main list and
    // gets chosen as the default executor, the gate believes it has tools and blocks every other
    // agent: that is precisely the real-machine deadlock. So the read side must refuse too:
    // only with a recipe does "enable" even make sense.
    const selectable = entry.needsRecipe !== true
    const enabledRaw = !selectable
      ? false
      : (disabledSet.has(entry.id)
        ? false
        : (enabledSet.has(entry.id) || (entry.available && installed)))
    // Roster entries not installed on this machine should not occupy the "selectable" list.
    //
    // Real-machine feedback (2026-10-20): that machine had only claude and codex, yet the list
    // still showed Qwen Code — because the list came from the **old roster** (11 leftovers from
    // 0.4.1), not from this machine's facts. The user's words: "detect what agents exist on the
    // other computer and write them in automatically" — so "what this machine does not have"
    // should not take a slot.
    //
    // Two exceptions:
    //   · It is currently selected by this session → it must be shown, or the user has no way
    //     to switch away from it.
    //
    // The rule is simply "not installed → no slot", **with no distinction between borrowed
    // entries and owned recipes**. An exemption for borrowed entries was considered ("what if
    // another plugin provides this tool?"), but then every launch-less entry in an old roster
    // would hang around in the list forever — exactly the phenomenon the user complained about.
    // As for "a tool provided by another plugin": as long as the corresponding CLI is on this
    // machine, `isInstalled` finds it via bin. If it truly cannot be found, it could not be
    // called anyway — hiding it is the honest option.
    const isActiveRow = active === entry.id
    const enabled = isActiveRow
      ? selectable
      : (enabledRaw && !installed ? false : enabledRaw)
    agents.push({
      id: entry.id,
      name: entry.name,
      tool: entry.tool,
      // The entry has no launch recipe of its own → its tool is registered by **another plugin**.
      // zcode's tool runtime has no enumeration interface, so we cannot confirm that plugin is
      // present (measured: without it, the tool simply does not exist — while the user has already
      // selected it in the picker, which looks like "the plugin is broken"). We say so honestly
      // here and do NOT change the gate's semantics — weakening the gate would erode a tested
      // isolation invariant.
      //
      // "Last call failed" is folded in as well: a dangling npm shim exposes itself at this step
      // (the file exists, the target program is gone) — exactly what the probing stage cannot detect.
      note: [
        entry.launch === null && String(entry.note || '').includes('entry point provided by another plugin') === false
          ? 'entry point provided by another plugin (install that plugin)'
          : '',
        brokenMap[entry.id] ? '\u26a0 last call failed: ' + String(brokenMap[entry.id].error || 'unknown reason') : '',
        entry.note,
      ].filter(Boolean).join('; ') || '',
      // The frontend can use this to draw a prominent marker; false when there is no failure record
      launchedBroken: Boolean(brokenMap[entry.id]),
      // This roster entry's launch recipe points at a script missing on this machine (legacy
      // leftover) → the frontend uses this to suggest "delete the roster and rely on auto-discovery".
      // Same criterion as the registration step.
      launchBroken: launchMissingRefs(entry.launch).length > 0,
      // Must be forwarded here too: readRoster() parses them, but the scan
      // result is what the browser half actually receives.
      expertise: entry.expertise,
      desc: entry.desc,
      // Forwarded so the menu can label the row "task-type" / "chat-type".
      kind: entry.kind,
      // True when this plugin registers the executor itself (inline `launch`),
      // as opposed to borrowing a tool another plugin owns.
      selfLaunched: entry.launch !== null,
      installed,
      enabled,
      // The frontend uses this to decide whether the row becomes the "click to see how to add
      // a recipe" guidance
      needsRecipe: entry.needsRecipe === true,
      // Display path. Absolute bins (every discovered member) are shown as-is;
      // a bare name is shown resolved against the managed dir.
      path: path.isAbsolute(entry.bin || '') ? entry.bin : path.join(dir, entry.bin || ''),
    })
  }
  return {
    dir,
    rosterFile: rosterFile(),
    // Count of legacy-roster leftovers — entries in the roster whose "recipe points at launch
    // scripts that do not exist on this machine".
    //
    // Why this number is needed: the plugin only seeds when the roster file does **not** exist and
    // never touches an existing one — correct (it is the user's file). But rosters from the 0.4.x
    // era carried 11 entries pointing at the author machine's wrappers (`*-zcode.ps1`); after the
    // upgrade none of them could run, while the list still showed that old edition — hence
    // "why did none of the twenty or thirty agents the new version added ever appear".
    // The frontend turns this number into one clear piece of advice, which beats me guessing
    // what the user wants.
    legacyRoster: agents.filter((a) => a && a.launchBroken === true).length,
    // The guidance copy must tell the user "save it as which file", so the path has to come from
    // here — the client must not assemble it itself (assembled wrong, it saves to a place nobody
    // reads).
    conventionDir: conventionDir(),
    agents,
    active,
    session: key,
    enabled: [...enabledSet],
    disabled: [...disabledSet],
  }
}

/**
 * The model-facing instruction for the active mode.
 *
 * Written as an operator instruction to the host model: it names the tool to use
 * and forbids asking again, so the user can simply type.
 *
 * The wording branches on the agent's KIND, because the two cases genuinely
 * differ and getting it wrong is user-visible:
 *   - task agents (Codex / Claude Code): the user's message IS the work order.
 *     Summarising the result is fine; that is what the user wants.
 *   - chat agents (OpenClaw): the user is talking, and the agent already keeps
 *     its own continuous conversation. The host model is only a pipe, so it must
 *     relay the reply VERBATIM. Paraphrasing here silently rewrites another
 *     agent's words — the user asked to talk to OpenClaw, not to a summary of it.
 */
export function modeGuidance(entry) {
  if (entry === null) {
    return 'The zcode-agent-picker plugin is installed on this machine (the Agent mode selector in the web GUI): a control to the right of the composer lets you pick an external Agent CLI as the [default executor], the way you pick a reasoning-effort tier. **No executor is currently selected** \u2014 treat user messages as plain conversation; do not call external CLIs automatically.'
  }
  const head = 'The zcode-agent-picker plugin is installed on this machine (the Agent mode selector in the web GUI): a control to the right of the composer lets you pick an external Agent CLI as the [default executor].'
  const who = `**The current default executor = ${entry.name}** (mode id: \`${entry.id}\`, kind: ${entry.kind === 'chat' ? 'chat-type' : 'task-type'}).`

  if (entry.kind === 'chat') {
    return [
      head,
      who,
      `Therefore: every single user message goes to ${entry.name} by default; the user will not (and need not) state this in the message.`,
      `When a user message arrives, call \`${entry.tool}\`: put the message body into its \`prompt\` argument **verbatim** (compatibility alias \`task\`), plus a 3-5 word \`description\` as the title. The user is talking to ${entry.name}, not to you \u2014 do not rewrite it, do not add background, do not wrap it in "please help me" style phrasing.`,
      `When the reply arrives, relay ${entry.name}\u2019s answer to the user **verbatim**: no summarizing, no compressing, no polishing, no omitting details, and no explaining on its behalf. You may say it came from ${entry.name}, but the content must stay identical.`,
      `Do not answer the user\u2019s question yourself \u2014 you are only the conduit. The only exception: when the user explicitly asks "do it yourself / don\u2019t call ${entry.name} / plain conversation / cancel the mode", treat it as plain conversation.`,
      'Do not explain this routing rule in your reply; just follow it.',
    ].join('\n')
  }

  return [
    head,
    who,
    `Therefore: every single user message is executed by ${entry.name} by default; the user will not (and need not) state this in the message.`,
    `When a user message arrives, call \`${entry.tool}\`: put the message body (shaped into a self-contained task description) into its \`prompt\` argument (compatibility alias \`task\`), plus a 3-5 word \`description\` as the title. Do not ask the user back "should I use ${entry.name}", and do not merely restate or rewrite the task.`,
    `Exception: only when the user explicitly asks "do it yourself / don\u2019t call ${entry.name} / plain conversation / cancel the mode" do you treat it as plain conversation.`,
    'Do not explain this routing rule in your reply; just execute.',
  ].join('\n')
}

/**
 * In-process caches for the SYNCHRONOUS readers.
 *
 * Both the prompt section's text function and the tool guard run on hot paths
 * where I/O is impossible (the guard must not even return a Promise). So the
 * roster and every session's choice are kept in memory, primed at boot and
 * updated on each accepted write.
 *
 * `cachedModes` is keyed by session, mirroring the on-disk shape: one entry per
 * conversation. A missing key means "this session has not chosen", which is the
 * unset state — never another session's value.
 */
let cachedRoster = []
let cachedModes = new Map()

/** Install the roster the readers validate against. */
export function cacheRoster(roster) {
  cachedRoster = Array.isArray(roster) ? roster : []
}

/** Replace the whole session→mode map (boot). Synchronous. */
export function cacheModes(modes) {
  const source = modes && typeof modes === 'object' ? modes : {}
  const entries = Object.entries(source).filter(([key, value]) => {
    if (typeof key !== 'string' || key === '') return false
    const id = value && typeof value.id === 'string' ? value.id : null
    return id !== null && id !== '' && id !== 'off'
  })
  // Same upper-bound rule as the write side: keep only the most recently used MAX_SESSION_MODES
  // sessions.
  //
  // The write side always had this bound; the read side did not: what gets written out is always
  // ≤200 entries, but what gets **read in** was taken as-is. If the state file was hand-edited or
  // came from an old version, the cache would grow without bound — the two sides answering
  // differently about "how much fits" is exactly that recurring "two paths disagree" failure.
  entries.sort((a, b) => String((b[1] && b[1].at) || '').localeCompare(String((a[1] && a[1].at) || '')))
  cachedModes = new Map()
  for (const [key, value] of entries.slice(0, MAX_SESSION_MODES)) cachedModes.set(key, value.id)
  // Paired with syncGuardMode's log: one records "whole-map replace", the other "single update";
  // together they can reconstruct what the cache held at any moment and which step changed it.
  diagnose(`cache load: default executor for ${cachedModes.size} sessions (from disk)`)
}

/** Update ONE session's cached choice. Synchronous on purpose. */
export function syncGuardMode(sessionKey, id) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  const normalized = id === '' || id === 'off' || id === undefined || id === null ? null : String(id)
  if (normalized === null) cachedModes.delete(key)
  else cachedModes.set(key, normalized)
  // One log line: this is the **only** place that can change the in-memory cache without
  // touching the disk.
  //
  // Why it was added: one real debugging session. On the evening of 2026-09-22 we found "the
  // prompt section says the default executor is X, but the disk has no record for this session
  // at all" — the UI (reading disk) showed "unset" while the model (reading memory) was told X.
  // Each path read its own source and each was "not wrong", yet the user saw a self-contradictory
  // picture. At the time there was no way, from outside the process, to tell who changed the
  // cache or when. This line exists for the next time: every cache change is logged with a
  // timestamp and value, directly comparable against the state file's write time.
  //
  // The volume is tiny: one line per UI switch.
  diagnose(`cache update: session ${key}\u2019s default executor = ${normalized === null ? '(unset)' : normalized}`)
  return normalized
}

/**
 * The choice for one session, read LIVE from the cache (no turn locking).
 *
 * This is the primitive `modeForTurn` builds on. Production readers (the prompt
 * section and the tool guard) deliberately call `modeForTurn` instead, so that a
 * mode switch cannot change the executor of a message already being processed.
 * Exposed mainly so tests can exercise both the live and the locked behaviour.
 */
export function cachedGuardMode(sessionKey) {
  const key = sessionKeyOf(sessionKey)
  if (key === null) return null
  return cachedModes.get(key) ?? null
}

/**
 * Mode SNAPSHOTS, one per turn: `AbortSignal` -> mode id (or null).
 *
 * The mode is LOCKED for the whole turn. Without this, a switch made while an
 * agent is still thinking would apply to the very turn that is in flight: zcode
 * re-assembles the system prompt on EVERY step and evaluates the guard on EVERY
 * tool call, so mid-turn the section text and the gate would both flip — and a
 * call that was legitimate a second earlier could be denied. That is
 * disorienting: you send one message and get two different executors.
 *
 * The turn-level `AbortSignal` identifies a turn exactly, and the SAME object
 * reaches both readers:
 *   - the prompt assembly context (`assembleContextFor(agent, signal)`)
 *   - every tool execution (`exec.signal`, built in `executeToolCalls`)
 * so whichever runs first pins the mode and the rest of the turn reuses it.
 * A new turn gets a new signal, so a switch takes effect on the next message.
 *
 * A WeakMap: a turn's snapshot must not outlive the turn.
 */
const turnModeSnapshots = new WeakMap()

/**
 * The mode governing the CURRENT TURN.
 *
 * Reads the session's mode once per turn and pins it, so a change made while the
 * agent is still thinking applies to the NEXT turn, never to the one in flight.
 * Accepts any shape carrying a session identity plus an optional `signal` — both
 * the assembly context and the tool execution qualify.
 */
export function modeForTurn(candidate) {
  const key = sessionKeyOf(candidate)
  if (key === null) return null
  const signal = candidate !== null && typeof candidate === 'object' ? candidate.signal : null
  if (signal !== null && signal !== undefined && typeof signal === 'object') {
    if (turnModeSnapshots.has(signal)) return turnModeSnapshots.get(signal)
    const snapshot = cachedGuardMode(key)
    turnModeSnapshots.set(signal, snapshot)
    return snapshot
  }
  // No turn identity (tests, or a direct call): read live, exactly as before.
  return cachedGuardMode(key)
}

/** Roster entry for an id, from the in-memory roster (synchronous). */
function entryForCached(id) {
  if (id === null || id === undefined) return null
  const found = cachedRoster.find((e) => e.id === id) || null
  // A needsRecipe member has no callable tool and cannot be an executor — treat as "unset".
  // Otherwise the prompt section would tell the model "your executor is X" while X's tool does
  // not exist at all: the model either stalls or the gate blocks every other agent (the
  // real-machine deadlock).
  if (found && found.needsRecipe === true) return null
  return found
}

/**
 * Mount the routes and the dynamic prompt section.
 * @param ctx - context carrying webServer and systemPrompt.
 */
export function apply(ctx) {
  // Log the version on the very first line — the thing real-machine diagnostic
  // reports miss most.
  //
  // The 2026-10-24 report provided everything (roster, state, where, npm dir,
  // codex dir) yet nowhere showed **which version was running**. So "is the fix
  // actually installed" could only be guessed — and between 0.5.1 and 0.5.3
  // every single step changed the decision logic.
  diagnose(`boot: zcode-agent-picker v${PLUGIN_VERSION} \u00b7 node ${process.version} \u00b7 ${process.platform} \u00b7 DSH_HOME=${dshHome()}`)
  // Clean up legacy leftovers first, then read the roster — the order cannot be
  // reversed: readRosterSync caches the merged result, and reading first would
  // cache the very entries we are about to delete.
  try { pruneLegacyRoster() } catch { /* has its own fallback */ }
  // Prime the roster synchronously, before anything can ask for a section text.
  cacheRoster(readRosterSync())

  // --- dynamic, PER-SESSION prompt section ----------------------------------
  // ONE registration whose `text` is a FUNCTION of the assembly context.
  //
  // This is the fix for the cross-session bleed. The old code re-registered a
  // single static string whenever the mode changed, so it could only ever
  // express one global choice — switching the Agent in one conversation
  // switched it in every other conversation too. zcode calls a function-typed
  // `text` on every assembly with `{ agent, scope: agent }`, so the section can
  // now answer per session, which is what "sessions are independent" requires.
  const diagnosedKeys = new Set()
  // The same "what did it resolve to" line is logged only once, to avoid
  // flooding the log every round.
  const diagnosedTexts = new Set()
  const sectionText = (context) => {
    try {
      const key = sessionKeyOf(context)
      // One diagnostic per session key, so we can confirm that zcode's agent
      // identity matches the id the browser sends. Logged once per key, never
      // per step, so a long conversation cannot flood the log.
      if (key === null) {
        if (!diagnosedKeys.has('__no-key__')) {
          diagnosedKeys.add('__no-key__')
          diagnose('prompt section assembly: the context carries no session identity (treated as unset) \u2014 if the mode seems not to apply, check here first')
        }
      } else if (!diagnosedKeys.has(key)) {
        diagnosedKeys.add(key)
        diagnose(`prompt section assembly: session key = ${key} | ${describeSessionContext(context)}`)
      }
      const resolvedId = modeForTurn(context)
      const resolvedEntry = entryForCached(resolvedId)
      // Write out both the resolution result and the tool name, so the two can
      // be told apart.
      //
      // ⚠ This whole diagnostic block must **swallow its own exceptions**.
      //
      // It runs inside the outer try, and the outer catch's fallback is
      // "degrade to unset" — meaning a single slip in this log code (say,
      // cachedRoster not being an array) would turn the prompt section into
      // "unset", and the model would then call no agent at all. That is the
      // exact symptom we would be debugging — a diagnostic must never
      // manufacture it. Diagnostics may fail; routing may not.
      try {
        if (key !== null) {
          // Reuse the resolvedId computed above — do not call modeForTurn again.
          // It carries "locked within the turn" semantics (the first time it sees
          // a signal it records the choice at that moment); calling it twice in
          // one assembly is pure self-sabotage. It can also return undefined,
          // which a === null check would miss — hence the unified judgment below.
          const chosen = resolvedId === null || resolvedId === undefined ? 'none' : String(resolvedId)
          const roster = Array.isArray(cachedRoster) ? cachedRoster : []
          // Distinguish three kinds of "no executor resolved":
          //   · genuinely nothing selected (none)
          //   · selected but the entry has no usable recipe (needsRecipe) → treated as unset, by design
          //   · selected but not found in the roster (deleted/renamed) → treated as unset, also by design
          const known = chosen !== 'none' ? roster.find((e) => e.id === chosen) : null
          const mark = resolvedEntry
            ? resolvedEntry.name + ' (' + (resolvedEntry.tool || '') + ')'
            : (chosen === 'none'
              ? 'unset'
              : (known && known.needsRecipe === true
                ? 'unset (' + chosen + ' has no usable recipe)'
                : 'unset (not in the roster: ' + chosen + ')'))
          const line = 'prompt section: ' + mark + ' \u00b7 chosen=' + chosen
          if (!diagnosedTexts.has(line)) {
            diagnosedTexts.add(line)
            diagnose(line)
          }
        }
      } catch { /* a failed diagnostic must not affect routing */ }
      return modeGuidance(resolvedEntry)
    } catch (error) {
      // This runs inside zcode's prompt assembly: throwing here would fail the
      // whole turn, so fall back to the neutral "no executor" text and say so.
      diagnose(`prompt section assembly failed (degraded to unset): ${error && error.message ? error.message : String(error)}`)
      return modeGuidance(null)
    }
  }

  ctx.effect(() => {
    let disposeSection = null
    try {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:agent-picker',
        order: 216,
        text: sectionText,
      })
      // Logged because this registration can silently fail: zcode applies plugins
      // more than once during boot, and a duplicate section name in the same
      // layer THROWS. The catch below swallows that — and a swallowed duplicate
      // is indistinguishable from "the section is gone", which would disable the
      // mode without a single error. One line makes it visible.
      diagnose('prompt section registered (order=216, text is a function)')
    } catch (error) {
      diagnose(`prompt section registration failed (duplicate name / double mount?): ${error && error.message ? error.message : String(error)}`)
    }
    return () => {
      try { if (typeof disposeSection === 'function') disposeSection() } catch { /* ignore */ }
      disposeSection = null
    }
  }, 'zcode-agent-picker: prompt section')

  // Load every session's choice at boot — SYNCHRONOUSLY, before returning.
  //
  // Not an effect with a promise: the section text function reads this map on
  // every assembly, and an async load leaves a window where the map is empty.
  // Worse, zcode tears effects down and rebuilds them during boot, so a pending
  // promise could resolve against a dead context and the map would stay empty
  // forever — every session would silently read as "unset". A synchronous read
  // of a small local JSON removes the whole class of problem.
  cacheModes(readStateSync().modes)

  // --- executor tools for roster entries that bring their own command line ---
  // Agents whose tool belongs to another plugin (Claude Code / Codex via
  // zcode-sub-cli) are deliberately left alone; only self-described launchers get
  // a tool registered here.
  //
  // CRITICAL: everything here is SYNCHRONOUS, on purpose. This effect is created
  // and torn down again during boot, so registering from a promise callback ran
  // against an already-inactive ctx: the call returned a disposer and looked
  // successful, but the definition went into a dead context and the agent never
  // saw the tool ("unknown tool", while the guard — which is context-free —
  // registered fine). Do not reintroduce an await between here and register().
  ctx.effect(() => {
    let disposeTools = () => {}
    let disposeGuard = null
    diagnose('executor effect: starting synchronous roster read')
    const roster = readRosterSync()
    diagnose(`roster read complete: ${roster.length} entries -> ${roster.map((e) => e.id + (e.launch ? '(launch)' : '')).join(', ')}`)
    // Prime the synchronous guard's roster cache before registering either.
    cacheRoster(roster)
    disposeTools = registerLaunchTools(ctx, roster)

    // Guard is registered alongside the tools so "only the chosen agent may
    // run" holds for borrowed tools (Claude Code / Codex) as well.
    // SIGNATURE: agentToolGuard(roster, lookupMode) -> (exec) => reason|undefined.
    // It must stay synchronous; see the warning on agentToolGuard.
    // The lookup is `modeForTurn`, not the raw cache: one message must run under
    // ONE executor even if the user switches while it is still thinking.
    if (typeof ctx.tools?.guard === 'function') {
      try {
        const predicate = agentToolGuard(roster, modeForTurn)
        if (typeof predicate !== 'function') {
          throw new Error('agentToolGuard did not return a function')
        }
        const result = ctx.tools.guard(predicate)
        disposeGuard = typeof result === 'function' ? result : null
        diagnose(`executor gate registered; disposer=${typeof result}`)
      } catch (error) {
        // Never let the guard take the tool system down with it: a failed
        // registration only loses the extra hard gate, not tool calls.
        diagnose(`executor gate registration failed (tool calls unaffected): ${error && error.message ? error.message : String(error)}`)
      }
    } else {
      diagnose('executor gate not registered: ctx.tools.guard is not a function')
    }
    return () => {
      try { disposeTools() } catch { /* ignore */ }
      try { if (typeof disposeGuard === 'function') disposeGuard() } catch { /* ignore */ }
    }
  }, 'zcode-agent-picker: executor tools')

  // --- routes ---------------------------------------------------------------
  ctx.effect(() => {
    // When there is no webServer, **do not throw**.
    //
    // zcode's boot is all-or-nothing: any plugin that throws during loading takes
    // the whole process down — the user sees "zcode won't open" without ever
    // learning which plugin did it. And webServer is not provided by every
    // assembly (headless / CLI-only runs have none).
    // Missing it only means "the panel cannot read the list"; the model-side
    // prompt section and executor keep working, so skip quietly and log a line.
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
      diagnose('no webServer: skipping route registration (panel unavailable, but the prompt section and executor still work)')
      return () => {}
    }
    const json = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 65536) raw = raw.slice(0, 65536) })
      req.on('end', () => resolve(raw))
      req.on('error', () => resolve(''))
    })

    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://zcode')
        const route = url.pathname.replace(/^\/zcode-agent-picker/, '')
        // The browser names its session explicitly. Everything below is scoped
        // to it, which is what keeps one conversation's choice from leaking into
        // another's.
        const session = url.searchParams.get('session')

        if (route === '/list') {
          const scan = await scanAgents(session)
          json(res, 200, { ok: true, ...scan })
          return
        }

        // Read-only: hand "what the model actually received" to the UI.
        //
        // The key point is that **the panel copies no copy text**: `guidance`
        // comes from `modeGuidance()` — the very function the prompt section
        // calls on every assembly. The characters in the UI are the characters
        // the model received; change the prompt and the panel follows. "The
        // panel says something different from reality" cannot happen.
        //
        // Both the "in-memory" and "on-disk" values are reported while we are at
        // it: normally they match; the moment they do not, the panel calls it
        // out on the spot — such divergences used to be findable only by
        // manually diffing files.
        if (route === '/inspect') {
          const key = sessionKeyOf(session)
          const disk = await readState()
          const onDisk = key !== null && disk.modes[key] ? disk.modes[key].id : null
          const live = key !== null ? cachedGuardMode(key) : null
          const entry = entryForCached(live)
          json(res, 200, {
            ok: true,
            session: key,
            mode: live,
            name: entry ? entry.name : null,
            kind: entry ? entry.kind : null,
            onDisk,
            guidance: modeGuidance(entry),
            gate: GATE_RULES,
            notes: GATE_NOTES,
            turnLocked: true,
          })
          return
        }

        // POST /selftest — have the plugin **itself** run that CLI once, entirely
        // without the model.
        //
        // Why this must exist: the 2026-10-29 and 11-01 real-machine logs both
        // showed "the tool is registered, the prompt section is right (prompt
        // section: Claude Code (cli_claude_direct)), yet not a single 'call'
        // appears in the log" — the model simply never called.
        // So "is the plugin right" and "will the model call" stayed tangled,
        // and nobody could say which.
        //
        // This route isolates the former: take the currently selected entry and,
        // with the same launch recipe, spawn one very short task, returning
        // ok / exitCode / duration / stdout / stderr as they are.
        //   · ok=true  → the plugin↔CLI pipeline is fine; the problem is 100% on the model side
        //   · ok=false → read stderr directly, fix the recipe
        // Writes no state, changes no selection; runs once and is discarded.
        if (route === '/selftest' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const wantId = parsed && typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : null
          const key = sessionKeyOf(session)
          const live = key !== null ? cachedGuardMode(key) : null
          const id = wantId || live
          if (id === null || id === undefined) {
            json(res, 400, { ok: false, error: 'No executor to self-test: select an agent first, or pass an id in the request' })
            return
          }
          const roster = Array.isArray(cachedRoster) ? cachedRoster : []
          const entry = roster.find((e) => e && e.id === id) || null
          if (!entry) {
            json(res, 404, { ok: false, error: 'Not in the roster: ' + id })
            return
          }
          if (!entry.launch || typeof entry.launch.bin !== 'string' || entry.launch.bin === '') {
            json(res, 409, { ok: false, error: entry.name + ' has no launch recipe (borrowed entry or unconfigured); there is nothing to self-test' })
            return
          }
          // The self-test uses an **independent** recipe: the real recipe may
          // allow 15 minutes; the self-test needs only 90 seconds.
          //
          // Also accepts timeoutMs in the request (3 s ~ 120 s), for two uses:
          //   · slow CLIs can be given more room;
          //   · tests can genuinely verify "it gets cut off at the deadline"
          //     with a short timeout, instead of only asserting the parameter exists.
          const wantTmo = Number(parsed && parsed.timeoutMs)
          const tmo = Number.isFinite(wantTmo) && wantTmo >= 3000 ? Math.min(wantTmo, 120000) : 90000
          const probe = Object.assign({}, entry.launch, {
            timeoutMs: tmo,
            graceMs: entry.launch.graceMs || 30000,
            maxBytes: 200000,
          })
          const t0 = Date.now()
          const r = await runLaunch(ctx, probe, { task: 'Reply with exactly two words: link ok', permission: '', model: '', image: '', workspace: '' })
          const ms = Date.now() - t0
          const head = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '')
          diagnose(`self-test ${entry.id}: ok=${r && r.ok === true} exit=${r && r.exitCode} took=${ms}ms`
            + (r && r.ok !== true ? ' \u00b7 error=' + head(r.error, 200) + ' \u00b7 stderr=' + head(r.stderr, 200) : ''))
          json(res, 200, {
            ok: r && r.ok === true,
            id: entry.id,
            name: entry.name,
            bin: probe.bin,
            argv: Array.isArray(r && r.argv) ? r.argv : undefined,
            exitCode: r && typeof r.exitCode === 'number' ? r.exitCode : null,
            ms,
            stdout: head(r && r.stdout, 600),
            stderr: head(r && r.stderr, 600),
            error: head(r && r.error, 600),
          })
          return
        }

        if (route === '/mode' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : 'off'
          const target = parsed && typeof parsed.session === 'string' ? parsed.session : session
          if (sessionKeyOf(target) === null) {
            json(res, 400, { ok: false, error: 'missing session: refuse to write a session-less mode' })
            return
          }
          const stored = await writeMode(target, id)
          // When the disk write fails, **do not** update the cache.
          // Updating it would split memory from disk: this process runs on the
          // new mode, silently reverts after a restart, and the user was told
          // "switch successful". Better an explicit failure (memory keeps the
          // disk's truth) than that kind of fake success.
          if (!stored.persisted) {
            json(res, 500, {
              ok: false,
              error: 'The mode was not saved to disk (could not write ' + dshHomePath() + '); this switch was abandoned',
            })
            return
          }
          // Keep the synchronous readers current before the next turn/tool call.
          syncGuardMode(target, stored.id)
          json(res, 200, { ok: true, id: stored.id, session: sessionKeyOf(target) })
          return
        }

        // Enable an agent (persist it into the roster's enabled set) without
        // necessarily switching to it. Used by the UI's "Installable" section.
        if (route === '/enable' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : null
          if (id === null) { json(res, 400, { ok: false, error: 'missing id' }); return }
          // Refuse to enable a "detected but no launch recipe" member.
          //
          // Such a member never gets a tool registered (there is no recipe to
          // register). Once it enters `enabled`, it appears in the main list and
          // can be chosen as the default executor — while the gate believes it
          // has tools and blocks every other agent. The real machine hit this
          // exact deadlock: after selecting Claude Code nothing could run, with
          // no way around it.
          // The client hides "\uFF0B" for such members too; this is the second gate —
          // the API must not be looser than the UI.
          try {
            const rosterNow = await readRoster()
            const target = rosterNow.find((e) => e && e.id === id)
            if (target && target.needsRecipe === true) {
              json(res, 409, {
                ok: false,
                error: 'This agent has no launch recipe yet and could not be called even if enabled. Use "How do I add one?" in the panel to add a launch entry first.',
              })
              return
            }
          } catch { /* roster unreadable → keep the old behavior and allow; never let a diagnostic check block the action */ }
          const result = await withStateLock(async () => {
            const state = await readState()
            const enabled = state.enabled.includes(id) ? state.enabled : [...state.enabled, id]
            // Clear any earlier "removed" mark, otherwise the explicit-enable
            // branch would be overruled by the disabled set on the next scan.
            const disabled = state.disabled.filter((x) => x !== id)
            const persisted = await writeState({ modes: state.modes, enabled, disabled })
            return { enabled, disabled, persisted }
          })
          if (!result.persisted) {
            json(res, 500, { ok: false, error: 'The enable was not saved to disk; this change was abandoned' })
            return
          }
          json(res, 200, { ok: true, enabled: result.enabled, disabled: result.disabled })
          return
        }

        // Remove an agent from the picker: record it in `disabled` so the
        // auto-enable rule cannot resurrect it, drop it from `enabled`, and drop
        // it from every session that had chosen it (an agent that is gone from
        // the menu must not remain anyone's silent default executor).
        if (route === '/disable' && req.method === 'POST') {
          const body = await readBody(req)
          let parsed = null
          try { parsed = JSON.parse(body || '{}') } catch { parsed = null }
          const id = parsed && typeof parsed.id === 'string' ? parsed.id : null
          if (id === null) { json(res, 400, { ok: false, error: 'missing id' }); return }
          const result = await withStateLock(async () => {
            const state = await readState()
            const enabled = state.enabled.filter((x) => x !== id)
            const disabled = state.disabled.includes(id) ? state.disabled : [...state.disabled, id]
            const modes = {}
            for (const [k, v] of Object.entries(state.modes)) {
              if (v && v.id === id) continue
              modes[k] = v
            }
            const persisted = await writeState({ modes, enabled, disabled })
            return { enabled, disabled, modes, persisted }
          })
          if (!result.persisted) {
            json(res, 500, { ok: false, error: 'The removal was not saved to disk; this change was abandoned' })
            return
          }
          // Refresh the synchronous views from what was actually persisted.
          cacheModes(result.modes)
          json(res, 200, { ok: true, enabled: result.enabled, disabled: result.disabled })
          return
        }

        json(res, 404, { ok: false, error: 'unknown route: ' + route })
      } catch (error) {
        try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* ignore */ }
      }
    }

    return ctx.webServer.register({ kind: 'prefix', path: '/zcode-agent-picker', handler })
  }, 'zcode-agent-picker: routes')
}

