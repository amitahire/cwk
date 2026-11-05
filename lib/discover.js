// agent-picker's built-in discovery table + probing functions (standalone module, tested on a real machine first)
//
// Key points (all tested conclusions, not guesses):
//  1. Search on PATH, and search [in PATHEXT order] — Windows npm packages leave
//     BOTH an extension-less POSIX shell script and a .cmd file; the extension-less
//     one cannot be executed by Windows
//     (on a real machine, one CLI's extension-less file started with `#!/bin/sh`).
//  2. A positive probe only means "the command is available", not "it can run": endpoints/keys are that agent's own business.
//  3. Only generate a default argv for agents whose [argument shape is confirmed]. For uncertain shapes, don't guess — mark needsConfig.

import { existsSync, statSync, accessSync, constants, readdirSync } from 'node:fs'
import { dirname, extname, join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Same semantics as the host's resolver: only tries PATHEXT (default .COM;.EXE;.BAT;.CMD).
 *
 * The `platform` parameter exists only for testability. POSIX has no PATHEXT — the command is a bare name.
 * The old implementation applied the Windows extension list unconditionally, so on macOS/Linux
 * `resolveOnPath('claude')` would only ever look for `claude.COM` / `claude.EXE` …
 * **never finding the real ./claude**, leaving probe results permanently empty.
 */
export function pathExts(env, platform = process.platform) {
  if (platform !== 'win32') return ['']
  const raw = (env && env.PATHEXT) || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').map((s) => s.trim()).filter(Boolean)
}

/**
 * Resolve a command inside one [specific directory]; returns an absolute path or null.
 *
 * Why this is needed: on a real machine, the user PATH does **not** include `~/zcode-clis/bin` (where the managed wrappers live)
 * and does **not** include `~/.local/bin` (where aider lives). Scanning PATH alone would never find codex or aider
 * — and those are exactly the two easiest to call. So the probe order is: PATH → cliBinDir.
 */
export function resolveInDir(command, directory, env = process.env) {
  if (!command || !directory) return null
  const exts = extname(command) === '' ? pathExts(env) : ['']
  for (const ext of exts) {
    const cand = resolve(directory, command + ext)
    try {
      if (statSync(cand).isFile()) { accessSync(cand, constants.X_OK); return cand }
    } catch {}
  }
  return null
}

/** Resolve a command on PATH; returns an absolute path or null. Semantics match zcode-subprocess-local. */
export function resolveOnPath(command, env = process.env) {
  if (!command) return null
  if (isAbsolute(command)) {
    try { if (statSync(command).isFile()) { accessSync(command, constants.X_OK); return command } } catch {}
    return null
  }
  const exts = extname(command) === '' ? pathExts(env) : ['']
  const dirs = String(env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = resolve(d, command + ext)
      try {
        if (statSync(cand).isFile()) { accessSync(cand, constants.X_OK); return cand }
      } catch {}
    }
  }
  return null
}

/**
 * Built-in table.
 *  discover : names to try on PATH (in order)
 *  argv     : argument template; only given for agents whose shape is confirmed
 *  permFlags: translates a permission tier into this CLI's own arguments (expanded into multiple arguments at `{permflags}`)
 *  defaultPermFlags : used when no tier is specified — must be "non-interactive", otherwise headless runs stall on approvals
 *  needsEnv : which environment variables this agent needs in order to work (used for the UI's "needs setup" hint)
 *  needsService : requires a resident service on this machine
 */
export const BUILTIN_AGENTS = [

  // ---- Has a launch recipe (directly callable) ----
  {
    id: 'codex', name: 'Codex', kind: 'task',
    discover: ['codex'],
    // The ChatGPT desktop app installs the CLI here (bin\<hash>\codex.exe), not on PATH.
    // Real-machine feedback: another computer had only the desktop app, so codex was never detected.
    deep: ['%LOCALAPPDATA%/OpenAI/Codex/bin'],
    desc: 'A terminal agent that runs commands, installs dependencies, and executes builds on its own, recording and reporting every step.',
    // codex exec defaults to -s read-only (cannot write files), so a sandbox tier must be given explicitly.
    argv: ['exec', '--skip-git-repo-check', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['-s', 'read-only'],
      'workspace-write': ['-s', 'workspace-write'],
      'danger-full-access': ['-s', 'danger-full-access'],
    },
    defaultPermFlags: ['-s', 'workspace-write'],
    needsEnv: [],
  },
  {
    id: 'claude', name: 'Claude Code', kind: 'task',
    discover: ['claude'],
    desc: "Anthropic's coding agent; the most consistent across large-scope code changes.",
    // -p is print (non-interactive) mode; without a permission mode, tool calls get refused or stall.
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--permission-mode', 'plan'],
      'workspace-write': ['--permission-mode', 'acceptEdits'],
      'danger-full-access': ['--permission-mode', 'bypassPermissions'],
    },
    defaultPermFlags: ['--permission-mode', 'acceptEdits'],
    needsEnv: [],
  },
  {
    id: 'qwen', name: 'Qwen Code', kind: 'task',
    discover: ['qwen'],
    desc: 'Open-source coding assistant forked from Gemini CLI; best at emitting fixed formats on request.',
    // In headless mode --approval-mode default waits for approval until timeout; it must be given explicitly.
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--approval-mode', 'plan'],
      'workspace-write': ['--approval-mode', 'yolo'],
      'danger-full-access': ['--approval-mode', 'yolo'],
    },
    defaultPermFlags: ['--approval-mode', 'yolo'],
    needsEnv: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'aider', name: 'Aider', kind: 'task',
    discover: ['aider'],
    desc: 'Makes only small, incremental code edits; every change is one revertible git commit.',
    // Without --yes-always, aider stops to ask follow-up questions and a headless run times out.
    argv: ['{permflags}', '--message', '{task}'],
    permFlags: {
      'read-only': ['--dry-run'],
      'workspace-write': ['--yes-always'],
      'danger-full-access': ['--yes-always'],
    },
    defaultPermFlags: ['--yes-always'],
    needsEnv: ['OPENAI_API_KEY', 'OPENAI_API_BASE'],
  },
  {
    id: 'goose', name: 'Goose', kind: 'task',
    discover: ['goose'],
    desc: 'A general-purpose assistant that chains actions like web browsing and file reading into reusable "recipes".',
    argv: ['run', '-t', '{task}'],
    needsEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'OPENAI_HOST'],
    // When permission tiers have no effect here, say so honestly — otherwise the UI is lying.
    permNote: 'It has no permission switch; choosing read-only/workspace-write has no effect — it runs under Goose\'s own default policy',
  },
  {
    id: 'hermes', name: 'Hermes', kind: 'task',
    discover: ['hermes'],
    desc: 'Accumulates the work it has done into a skill library; similar jobs go noticeably smoother the second time.',
    argv: ['-z', '{task}'],
    needsEnv: [],
    // When permission tiers have no effect here, say so honestly — otherwise the UI is lying.
    permNote: 'It has no permission switch; choosing read-only/workspace-write has no effect — it runs under its own default policy',
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'task',
    discover: ['gemini'],
    desc: "Google's terminal coding assistant; same foundation as Qwen Code.",
    argv: ['-p', '{permflags}', '{task}'],
    permFlags: {
      'read-only': ['--approval-mode', 'plan'],
      'workspace-write': ['--approval-mode', 'yolo'],
      'danger-full-access': ['--approval-mode', 'yolo'],
    },
    defaultPermFlags: ['--approval-mode', 'yolo'],
    needsEnv: ['GEMINI_API_KEY'],
    needsService: 'Needs an intermediate layer (such as LiteLLM) to translate the Gemini protocol to your endpoint',
  },
  {
    id: 'ollama', name: 'Ollama (local)', kind: 'chat',
    discover: ['ollama'],
    desc: 'Runs open models on your local GPU; works offline.',
    argv: ['run', 'qwen3:4b', '{task}'],
    needsEnv: [],
    needsService: 'Requires a local ollama service to be running',
    permNote: 'Local models only handle conversation and never modify files, so there is no permission switch',
  },
  {
    id: 'opencode', name: 'opencode', kind: 'task',
    discover: ['opencode'],
    desc: 'Open-source terminal coding agent, primarily a TUI, also supports one-shot execution.',
    argv: ['run', '{task}'],
    needsEnv: [],
    // When permission tiers have no effect here, say so honestly — otherwise the UI is lying.
    permNote: 'It has no permission switch; choosing read-only/workspace-write has no effect — it runs under its own default policy',
  },
  {
    id: 'crush', name: 'Crush', kind: 'task',
    discover: ['crush'],
    // Recognized only: Charm's crush currently has an open issue requesting a "non-interactive batch mode"
    // (charmbracelet/crush#1030), which means the `crush run <task>` path did not exist at the time.
    // Guessing a subcommand that doesn't exist = the user clicks and gets a guaranteed error, so it's better to offer nothing.
    desc: "Charm's terminal coding assistant; the flashiest UI of the bunch.",
    needsEnv: [],
  },
  {
    id: 'cursor', name: 'Cursor CLI', kind: 'task',
    discover: ['cursor-agent', 'cursor'],
    desc: "The Cursor editor's terminal agent; shares the same code understanding as the editor.",
    // Arguments taken from cursor-agent's --help (third-party real-machine record, 2026-06 edition):
    //   -p/--print non-interactive; --trust skips the workspace-trust prompt (required for headless, otherwise it waits for input)
    //   --force auto-executes and applies changes (the deny list still applies); --mode plan reads without changing
    argv: ['-p', '{permflags}', '--trust', '{task}'],
    permFlags: {
      'read-only': ['--mode', 'plan'],
      'workspace-write': ['--force'],
      'danger-full-access': ['--force'],
    },
    defaultPermFlags: ['--force'],
    needsEnv: [],
  },
  {
    id: 'kimi', name: 'Kimi', kind: 'task',
    discover: ['kimi'],
    desc: "Moonshot AI's command-line coding assistant; strong with long Chinese context.",
    // Official docs: -p/--prompt is a single non-interactive run, no TUI.
    // Note --prompt must **not** be combined with --yolo/--auto/--plan — non-interactive mode itself
    // already runs with auto permissions, so no {permflags} here.
    argv: ['-p', '{task}'],
    needsEnv: [],
    // When permission tiers have no effect here, say so honestly — otherwise the UI is lying.
    permNote: 'It has no permission switch; choosing read-only/workspace-write has no effect — it runs under its own default policy',
  },


  // ---- Recognized only, not auto-called (launch arguments unverified, to avoid "shown but not callable") ----
  {
    id: 'copilot', name: 'GitHub Copilot CLI', kind: 'task',
    discover: ['copilot'],
    desc: "GitHub's official command-line Copilot — the closest integration with the GitHub ecosystem.",
    needsEnv: [],
  },
  {
    id: 'trae', name: 'Trae', kind: 'task',
    discover: ['trae', 'trae-cli', 'traecode'],
    desc: "ByteDance's AI coding tool, available as a standalone IDE and as a terminal form.",
    needsEnv: [],
  },
  {
    id: 'amp', name: 'Amp', kind: 'task',
    discover: ['amp'],
    desc: "Sourcegraph's terminal coding agent, focused on multi-file refactoring.",
    needsEnv: [],
  },
  {
    id: 'droid', name: 'Droid', kind: 'task',
    discover: ['droid'],
    desc: "Factory's software-engineering agent, oriented toward automation pipelines.",
    needsEnv: [],
  },
  {
    id: 'auggie', name: 'Augment Code', kind: 'task',
    discover: ['auggie'],
    desc: "Augment's command-line agent; its strength is locating context in large codebases.",
    needsEnv: [],
  },
  {
    id: 'openhands', name: 'OpenHands', kind: 'task',
    discover: ['openhands'],
    desc: 'Open-source autonomous agent that can run a whole task from scratch inside a sandbox.',
    needsEnv: [],
  },
  {
    id: 'cline', name: 'Cline', kind: 'task',
    discover: ['cline'],
    desc: 'Open-source coding agent that started as a VS Code extension and also has a CLI.',
    needsEnv: [],
  },
  {
    id: 'windsurf', name: 'Windsurf', kind: 'task',
    discover: ['windsurf'],
    desc: "Codeium's AI coding environment, focused on workflow continuity.",
    needsEnv: [],
  },
  {
    id: 'qoder', name: 'Qoder', kind: 'task',
    discover: ['qoder'],
    desc: "Alibaba's AI coding tool; Tongyi Lingma has been merged into it.",
    needsEnv: [],
  },
  {
    id: 'codebuddy', name: 'CodeBuddy', kind: 'task',
    discover: ['codebuddy'],
    desc: "Tencent's AI coding assistant, available as a CLI and as an IDE plugin.",
    needsEnv: [],
  },
  {
    id: 'grok', name: 'Grok CLI', kind: 'task',
    discover: ['grok', 'grok-cli'],
    desc: "xAI's command-line agent; can execute terminal commands directly.",
    needsEnv: [],
  },
  {
    id: 'openclaw', name: 'OpenClaw', kind: 'chat',
    discover: ['openclaw'],
    desc: 'A gateway-style assistant resident on your machine, with a web console and persistent context.',
    needsEnv: [],
  },
  {
    id: 'kilo', name: 'Kilo Code', kind: 'task',
    discover: ['kilo'],
    desc: 'Open-source coding agent from the Cline / Roo family.',
    needsEnv: [],
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', kind: 'task',
    discover: ['workbuddy'],
    desc: 'An assistant for workflow automation, more about tool calls than writing code.',
    needsEnv: [],
  },

  {
    id: 'codegeex', name: 'CodeGeeX', kind: 'task',
    discover: ['codegeex'],
    desc: "Zhipu's coding assistant, available as an IDE plugin and as a CLI.",
    // Recognized only, no recipe: the non-interactive arguments were never verified — no guessing.
    needsEnv: [],
  },
  {
    id: 'plandex', name: 'Plandex', kind: 'task',
    discover: ['plandex'],
    desc: 'A terminal agent that breaks big tasks into step-by-step runs inside a sandbox.',
    // Recognized only, no recipe: the non-interactive arguments were never verified — no guessing.
    needsEnv: [],
  },
  {
    id: 'codebuff', name: 'CodeBuff', kind: 'task',
    discover: ['codebuff'],
    desc: 'Open-source terminal coding agent that edits files directly in the project.',
    // Recognized only, no recipe: the non-interactive arguments were never verified — no guessing.
    needsEnv: [],
  },
  {
    id: 'gptme', name: 'gptme', kind: 'task',
    discover: ['gptme'],
    desc: 'Open-source terminal assistant that can read/write files and run shell commands.',
    // Recognized only, no recipe: the non-interactive arguments were never verified — no guessing.
    needsEnv: [],
  },
  {
    id: 'interpreter', name: 'Open Interpreter', kind: 'task',
    discover: ['interpreter'],
    desc: 'A terminal tool you direct in everyday language to run tasks on your machine.',
    // Recognized only, no recipe: the non-interactive arguments were never verified — no guessing.
    needsEnv: [],
  },
]

/**
 * Probe which agents are available on this machine.
 *
 * Probe order (each layer may hold a hit; first hit wins):
 *   ① PATH                      — standard CLIs installed system-wide
 *   ② extraDirs (cliBinDir etc.) — the managed wrapper directory; in practice it is **not** on PATH
 *
 * @param env       environment (determines PATH and "which env vars are missing")
 * @param extraDirs extra directories to probe, in order
 * @returns [{ id, name, kind, found, exe, exeFrom, argv, missingEnv, ready, needsService }]
 */
/**
 * Directories to search by default — all common install locations that don't land on PATH.
 *
 * Real-machine feedback (2026-10-20, another computer): both `claude` and `qwen` were installed
 * with `npm i -g`, landing in %APPDATA%\npm. That directory is **usually** on the user PATH, but the PATH the
 * zcode desktop app gets when launched from the GUI may not include it — the result: the plugin detects
 * nothing at all, and the user keeps seeing the old roster's "borrowed someone else's entry" row. So we add these proactively.
 */
export function defaultSearchDirs(env = process.env) {
  const out = []
  if (env.APPDATA) out.push(join(env.APPDATA, 'npm'))          // Windows npm global
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'npm')) // some installers use this one
  out.push(join(homedir(), '.npm-global', 'bin'))               // POSIX npm global
  out.push(join(homedir(), '.local', 'bin'))                    // pipx / uv
  return out
}

/** Templates like `%LOCALAPPDATA%/OpenAI/Codex/bin` → real path; returns null if a variable is missing. */
export function expandEnvPath(template, env = process.env) {
  let missing = false
  const p = String(template).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name) => {
    const v = env[name]
    if (typeof v !== 'string' || v === '') { missing = true; return '' }
    return v
  })
  return missing ? null : p
}

/**
 * Find a command inside a directory that has "one more level of hash/version subdirectory" inside it.
 *
 * Why this exists: the ChatGPT desktop app installs the Codex CLI at
 *   %LOCALAPPDATA%\OpenAI\Codex\bin\<some-hash>\codex.exe
 * — not on PATH, not in any fixed directory, and the hash-named folder changes on every update.
 * Scans one level of subdirectories only, trying them newest-first by directory mtime.
 */
export function resolveInDeepDir(commands, baseDir, env = process.env) {
  if (!baseDir) return null
  let subs = []
  try {
    subs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = join(baseDir, d.name)
        let mtime = 0
        try { mtime = statSync(full).mtimeMs } catch { /* ignore */ }
        return { full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return null
  }
  const names = Array.isArray(commands) ? commands : [commands]
  for (const s of subs) {
    for (const c of names) {
      const hit = resolveInDir(c, s.full, env)
      if (hit) return hit
    }
  }
  return null
}

export function discoverAgents(env = process.env, extraDirs = []) {
  const dirs = (Array.isArray(extraDirs) ? extraDirs : [extraDirs])
    .filter((d) => typeof d === 'string' && d !== '')
    .concat(defaultSearchDirs(env))
    .filter((d, i, arr) => arr.indexOf(d) === i)
  const rows = []
  for (const spec of BUILTIN_AGENTS) {
    let exe = null
    let exeFrom = null
    for (const c of spec.discover) {
      exe = resolveOnPath(c, env)
      if (exe) { exeFrom = 'PATH'; break }
    }
    if (!exe) {
      for (const c of spec.discover) {
        for (const d of dirs) {
          exe = resolveInDir(c, d, env)
          if (exe) { exeFrom = 'cliDir'; break }
        }
        if (exe) break
      }
    }
    // One level of subdirectories hidden inside another program's install directory (e.g. the ChatGPT desktop app's Codex)
    if (!exe && Array.isArray(spec.deep)) {
      for (const tpl of spec.deep) {
        const base = expandEnvPath(tpl, env)
        if (!base) continue
        exe = resolveInDeepDir(spec.discover, base, env)
        if (exe) { exeFrom = 'deep'; break }
      }
    }
    const missingEnv = (spec.needsEnv || []).filter((k) => !env[k])
    const hasArgv = Array.isArray(spec.argv) && spec.argv.length > 0
    rows.push({
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      desc: spec.desc || '',
      found: !!exe,
      exe,
      exeFrom,
      argv: hasArgv ? spec.argv : null,
      // Permission tier → this CLI's own arguments. Missing both means "this CLI has no permission switch".
      permFlags: spec.permFlags || null,
      defaultPermFlags: spec.defaultPermFlags || null,
      missingEnv,
      needsService: spec.needsService || null,
      // When a permission tier has no effect here, say so (the frontend / note line must see it)
      permNote: spec.permNote || null,
      // "Usable": found + a definite argv + no missing env vars + no service that must be started first
      ready: !!exe && hasArgv && missingEnv.length === 0 && !spec.needsService,
    })
  }
  return rows
}
