// zcode-agent-picker browser half.
//
// Self-contained by hand (no bundler, no build step, zero dependencies): the zcode
// client module system wraps this in a CJS factory via window.__ModuleLoader__,
// and the kernel adopts { apply, inject } off the returned module.exports as a
// client plugin. React comes from the factory's own `require`.
//
// A MODE selector, like the reasoning-effort dropdown — but built for a machine
// that will accumulate MANY agents, so the menu is a manageable LIST rather than
// a fixed pair of rows:
//
//   ┌ No agent specified        ← plain zcode conversation
//   │ ✓ Claude Code         ×   ← enabled: selectable, removable
//   │   Codex               ×
//   ├ ▸ Installable (2)         ← collapsed; only installable-but-not-enabled
//   └ <roster>.json             ← footer: where the roster lives / how to add
//
// Selecting an agent POSTs it to the host as the conversation's default
// executor; the routing itself lives entirely on the host side (its
// system-prompt section is re-read on every step), so nothing is added to the
// user's message and nothing is inserted into the draft.
//
// Every failure is logged, never thrown: a throw from apply fails the whole web
// shell boot.
window.__ModuleLoader__.load({
  id: 'zcode-agent-picker',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Required services: the slot registry. */
    exports.inject = ['slots']

    // Inline styles only — no stylesheet, no theme coupling, nothing global.
    const buttonStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', fontSize: 12, lineHeight: '18px',
      border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
      background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    }
    const buttonOnStyle = { borderColor: 'rgba(80,150,255,0.75)', background: 'rgba(80,150,255,0.14)' }
    const menuStyle = {
      position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
      minWidth: 320, maxWidth: 380, padding: 4,
      border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8,
      background: 'Canvas', color: 'CanvasText', boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
      zIndex: 2147483000, maxHeight: 420, overflowY: 'auto',
    }
    const rowStyle = {
      display: 'flex', alignItems: 'center', gap: 6, width: '100%',
      // Right padding tightened from 8 to 3: the × used to sit "menu padding 4 +
      // row padding 8 = 12px" from the menu edge — far too tight. After the
      // narrowing, the whole column of right-side icons (? and ×) moves inward
      // together, and the two stay aligned.
      padding: '6px 3px 6px 8px', border: 'none', borderRadius: 6,
      background: 'transparent', color: 'inherit', fontSize: 12,
      textAlign: 'left', cursor: 'pointer',
    }
    const rowOnStyle = { background: 'rgba(80,150,255,0.16)' }
    const rowOffStyle = { opacity: 0.45, cursor: 'not-allowed' }
    const bodyStyle = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 }
    const nameStyle = { fontWeight: 600 }
    // Kind badge next to the agent name. "task" vs "chat" changes what the
    // user should expect: a task agent's result gets summarised back, a chat
    // agent's reply is relayed verbatim. Worth one small pill.
    const nameRowStyle = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
    const kindBadgeStyle = {
      flex: '0 0 auto', fontSize: 9, lineHeight: '15px', padding: '0 6px',
      borderRadius: 8, border: '1px solid rgba(127,127,127,0.4)',
      opacity: 0.75, whiteSpace: 'nowrap', fontWeight: 400,
    }
    const kindChatBadgeStyle = { borderColor: 'rgba(80,150,255,0.65)', opacity: 0.95 }
    // WRAPPING hint for agent rows. These strings are real information — tool
    // name + gateway address + endpoint + caveats — and they get long enough
    // that a single truncated line hid the tail completely (the OpenClaw row
    // lost "routes via the DeepSeek endpoint · gateway must be running" behind
    // an ellipsis with no way to read it). Wrapping costs a little height; the menu scrolls.
    const hintWrapStyle = {
      fontSize: 10, opacity: 0.65, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '14px',
    }
    // Icon buttons (remove / add). A 22x22 square keeps the glyph big enough to
    // read and the hit target big enough to click; the hover background makes it
    // obvious the row has its own control separate from the select action.
    const ICON_SIZE = 22
    const iconBase = {
      flex: '0 0 auto',
      width: ICON_SIZE, height: ICON_SIZE, lineHeight: (ICON_SIZE - 2) + 'px',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: '1px solid transparent', borderRadius: 6,
      background: 'transparent', color: 'inherit',
      fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: 0,
      transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
    }
    const removeIconStyle = Object.assign({}, iconBase, { opacity: 0.7 })
    const addIconStyle = Object.assign({}, iconBase, { opacity: 0.8 })
    const hoverIn = (event, danger) => {
      try {
        event.currentTarget.style.background = danger ? 'rgba(220,60,60,0.16)' : 'rgba(80,150,255,0.18)'
        event.currentTarget.style.borderColor = danger ? 'rgba(220,60,60,0.45)' : 'rgba(80,150,255,0.5)'
        event.currentTarget.style.opacity = '1'
      } catch (error) { /* hover polish must never break the menu */ }
    }
    const hoverOut = (event, base) => {
      try {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.borderColor = 'transparent'
        event.currentTarget.style.opacity = base
      } catch (error) { /* ignore */ }
    }
    const dotStyle = { flex: '0 0 auto', width: 6, height: 6, borderRadius: 3, background: 'rgb(80,150,255)' }
    const spacerStyle = { flex: '0 0 auto', width: 6 }
    // Capability text. The "good at" line is promoted above the technical hint
    // because it is what the user actually chooses on; the expanded blurb is
    // dimmer and wraps freely.
    const expertiseStyle = {
      fontSize: 12.5, opacity: 0.95, whiteSpace: 'normal', wordBreak: 'break-word',
      lineHeight: 1.5, letterSpacing: '0.01em',
    }
    // The expanded capability details. Font size deliberately raised to 12, line
    // height 1.75, opacity 0.86: this is what the user actually reads — the old
    // 10.5px + 0.72 was too small and faint, tiring on the eyes.
    //
    // whiteSpace must be pre-wrap (was normal): the roster's long descriptions use
    // newlines as numbered "1. 2. 3." lists, which normal would collapse into
    // spaces; pre-wrap keeps our newlines and still wraps long lines automatically.
    const descStyle = {
      fontSize: 12, opacity: 0.86, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.22)',
      lineHeight: 1.75, letterSpacing: '0.01em',
    }
    // The "how do I add a launch recipe" guidance block. Deliberately low-contrast
    // and small-font: it is a step-by-step walkthrough for first-time users and
    // must not steal attention while collapsed.
    const guideStyle = {
      display: 'block',
      marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(127,127,127,0.3)',
      fontSize: 12, lineHeight: 1.7, opacity: 0.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }
    const guideLineStyle = { display: 'block', marginBottom: 3 }
    const codeStyle = {
      display: 'block',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11.5, padding: '6px 8px', marginTop: 4, marginBottom: 4,
      whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all',
      background: 'rgba(127,127,127,0.12)', borderRadius: 4,
    }
    const miniBtnStyle = {
      fontSize: 11, padding: '1px 7px', marginLeft: 6, borderRadius: 4, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit',
      opacity: 0.85,
    }
    const infoIconStyle = Object.assign({}, iconBase, { opacity: 0.7, fontSize: 13 })
    const secStyle = {
      margin: '6px 0 3px', padding: '5px 8px 3px', fontSize: 11, opacity: 0.68,
      borderTop: '1px solid rgba(127,127,127,0.25)', display: 'flex', alignItems: 'center', gap: 4,
      cursor: 'pointer', userSelect: 'none', letterSpacing: '0.02em',
    }
    // The trailing "not installed on this machine" note: secondary info, keep it unobtrusive
  const absentLineStyle = { display: 'block', fontSize: 11, lineHeight: '17px', opacity: 0.45, padding: '2px 12px 4px 28px' }
  const probeBtnStyle = {
    margin: '6px 8px 0', padding: '4px 10px', fontSize: 11, cursor: 'pointer',
    border: '1px solid rgba(127,127,127,0.35)', borderRadius: 4,
    background: 'transparent', color: 'inherit', opacity: 0.85,
  }
  const probeOutStyle = {
    margin: '4px 8px 0', padding: '6px 8px', fontSize: 11, lineHeight: 1.55,
    borderLeft: '2px solid rgba(127,127,127,0.45)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    maxHeight: 160, overflow: 'auto', opacity: 0.85,
  }
  const footStyle = {
      marginTop: 6, padding: '5px 8px 3px', fontSize: 11, opacity: 0.55,
      borderTop: '1px solid rgba(127,127,127,0.25)', wordBreak: 'break-all', lineHeight: 1.6,
    }
    // The bottom-left "how it works" block. Collapsed to one line by default; expands in place inside the menu when opened.
    const inspectBoxStyle = {
      borderTop: '1px solid rgba(127,127,127,0.25)',
      padding: '4px 8px 6px', fontSize: 11, textAlign: 'left',
    }
    const inspectToggleStyle = {
      display: 'block', width: '100%', textAlign: 'left',
      background: 'transparent', border: 'none', color: 'inherit',
      font: 'inherit', fontSize: 12.5, fontWeight: 600, padding: '4px 0',
      cursor: 'pointer', opacity: 0.92,
    }
    const inspectBodyStyle = {
      marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6,
    }
    const inspectHeadStyle = { fontWeight: 600 }
    const inspectLabelStyle = { opacity: 0.6, fontSize: 10 }
    const inspectWarnStyle = {
      color: 'crimson', background: 'rgba(255,0,0,0.08)',
      padding: '4px 6px', borderRadius: 4,
    }
    const inspectPreStyle = {
      margin: 0, padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 10.5, lineHeight: 1.5,
      background: 'rgba(127,127,127,0.12)', borderRadius: 4,
      maxHeight: 220, overflow: 'auto',
    }
    const inspectUlStyle = { margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }
    const errStyle = { padding: '6px 8px', fontSize: 12, color: 'crimson' }
    const mutedStyle = { padding: '6px 8px', fontSize: 12, opacity: 0.65 }
    // Copy for the "no agent" row.
    //
    // It is deliberately NOT part of the roster data file: that file lists
    // external Agents, and this row is the absence of one. Wording changes go
    // right here. The row still gets the same treatment as an agent row (a
    // one-line summary plus an expandable explanation), because "no agent
    // specified" is a real, commonly-used choice and users could not tell what it does.
    const OFF_ROW_ID = '__off'
    const OFF_LABEL = 'No agent specified'
    const OFF_EXPERTISE = 'Good at: plain conversation, naming an agent for one-off tasks, and never taking over your messages'
    const OFF_DESC = 'Does not set any external agent as the default executor: every message is answered by zcode\'s own model.'
      + 'Note that the Agent tool is NOT disabled — you can still name one ad hoc, e.g. "have Codex run this script".'
      + 'To have an agent take over your messages for good, select its row above: from then on every message you send is handed to it by default,'
      + ' with no need to repeat its name. (Click it again to cancel.)'
      + '★ This choice is per-session — it affects only the current conversation; every other session stays independent.'

    async function api(path, options) {
      try {
        const res = await fetch('/zcode-agent-picker' + path, Object.assign({
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        }, options || {}))
        const json = await res.json()
        return json && json.ok === true ? json : null
      } catch (error) {
        console.warn('[zcode-agent-picker] api ' + path + ' failed:', error)
        return null
      }
    }

    // Every request names the session it belongs to.
    //
    // The slot `conversation.input.right` is session-scoped and zcode passes
    // `sessionId` among its standard props, so this component knows exactly
    // which conversation it is drawing controls for. Sending it is what keeps
    // the Agent choice per-conversation: without it the host has one global
    // value and every session follows whatever was clicked last.
    const fetchState = (sessionId) => api('/list' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''))
    const postMode = (sessionId, id) => api('/mode', { method: 'POST', body: JSON.stringify({ session: sessionId, id }) })
    const postEnable = (id) => api('/enable', { method: 'POST', body: JSON.stringify({ id }) })
    const postDisable = (id) => api('/disable', { method: 'POST', body: JSON.stringify({ id }) })
    // Self-test: have the plugin spawn that CLI itself (no model involved).
    //
    // This must NOT go through the api() above: it folds every `ok:false` into
    // null, and on a failed self-test the failure detail (exitCode / stderr /
    // error) is exactly what we need.
    const postSelftest = async (id) => {
      try {
        const res = await fetch('/zcode-agent-picker/selftest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(id ? { id } : {}),
        })
        return await res.json()
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }
    /** The composer control: shows the active executor, opens the agent list. */
    function AgentModeButton(props) {
      // Injected by the session-scoped slot. Absent only outside a conversation,
      // where a per-session choice has no meaning anyway.
      const sessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)   // { agents, active, dir, rosterFile }
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [showInstallable, setShowInstallable] = React.useState(false)
      const [expandedId, setExpandedId] = React.useState(null)
      const boxRef = React.useRef(null)

      // Monotonic request id, so a response that is no longer about the session
      // on screen can be discarded.
      //
      // Arrival order is not a reliable signal: switching conversations while a
      // `/list` is still in flight let the OLD session's payload land last, so
      // the control showed the other conversation's Agent — the exact symptom
      // the per-session fix exists to remove, just with a short window. The
      // reset below narrows that window but cannot close it, because the stale
      // response still arrives afterwards and re-fills the state.
      const reqRef = React.useRef(0)
      // State for the bottom-left "how it works" panel. Collapsed by default.
      const [showInspect, setShowInspect] = React.useState(false)
      const [inspect, setInspect] = React.useState(null)
      const [inspectErr, setInspectErr] = React.useState(null)
      // Result of the self-test. null = never run. { ok, exitCode, ms, stdout, stderr, error }
      //
      // Why the panel needs this button: real-machine logs kept showing "the tool
      // is registered and the prompt section is right, but the model never calls
      // it" — so whether the plugin/CLI pipeline works stayed hidden behind
      // whether the model deigns to call it. This button has the plugin spawn the
      // CLI itself, separating the two questions for good.
      const [probe, setProbe] = React.useState(null)
      const [probing, setProbing] = React.useState(false)

      // Which row's "how do I add a launch recipe" guide is expanded. All
      // collapsed by default — the guide only appears when the user opens it,
      // so it takes no space otherwise ("understandable, and not annoying").
      const [recipeHelpId, setRecipeHelpId] = React.useState(null)
      // Id of the row copied most recently, to flip the button to "Copied" briefly as feedback.
      const [copiedId, setCopiedId] = React.useState(null)

      // The panel copy is computed on the host side (/inspect); nothing is
      // duplicated here: what the panel must show is "the instruction text the
      // model actually receives", and that has exactly one source.
      const loadInspect = () => {
        if (sessionId === null) return
        api('/inspect?session=' + encodeURIComponent(sessionId)).then((next) => {
          if (next === null) { setInspectErr('Failed to load the how-it-works panel'); setInspect(null); return }
          setInspectErr(null)
          setInspect(next)
        })
      }
      // The CURRENT session, readable from inside a stale callback. Comparing
      // the echoed `session` against the closure's own `sessionId` would be
      // useless — a request's closure always holds the session it was made for,
      // so that comparison can never fail. (It was written that way first, and a
      // mutation test showed it caught nothing.) A ref is what makes it a real
      // second check, independent of the sequence token.
      const currentSessionRef = React.useRef(sessionId)

      const reload = React.useCallback(() => {
        if (sessionId === null) { setError('This control is only available inside a session'); return }
        const seq = ++reqRef.current
        fetchState(sessionId).then((next) => {
          if (seq !== reqRef.current) return          // superseded by a later request — discard
          if (next !== null && next.session !== undefined && next.session !== currentSessionRef.current) return
          if (next === null) setError('Failed to read the agent list')
          else { setState(next); setError(null) }
        })
      }, [sessionId])

      // On a session change, drop the previous session's data BEFORE fetching.
      // The slot may reuse this component across sessions; without the reset the
      // label would briefly show the OTHER conversation's Agent, which is
      // exactly the symptom this per-session fix exists to remove.
      React.useEffect(() => {
        currentSessionRef.current = sessionId
        setState(null)
        setError(null)
        setOpen(false)
        setExpandedId(null)
        reload()
      }, [reload])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          try { if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false) }
          catch (err) { console.warn('[zcode-agent-picker] outside-click failed:', err) }
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // Double-click protection uses a ref, not state.
      // state only updates after this render completes, and the button's onClick
      // still carries the PREVIOUS render's closure until then (its busy still
      // reads false) — rapid clicks in that instant slip straight through.
      // A ref is one shared object; every closure reads the current value.
      const busyRef = React.useRef(false)
      const act = (makeRequest) => {
        // Ignore the click while the previous request is still in flight.
        // The argument must be a FUNCTION: call sites used to read act(postMode(...)),
        // so the argument was evaluated before entering here — by the time busy was
        // checked the request had already gone out. Passing a function lets this
        // place decide whether to send it.
        if (busyRef.current) return
        busyRef.current = true
        let promise
        try {
          setBusy(true)
          promise = makeRequest()
        } catch (err) {
          busyRef.current = false
          setBusy(false)
          console.warn('[zcode-agent-picker] action threw:', err)
          return
        }
        promise.then(() => { busyRef.current = false; setBusy(false); reload() })
          .catch((err) => {
            busyRef.current = false
            setBusy(false)
            console.warn('[zcode-agent-picker] action failed:', err)
          })
      }

      // Click = **select**, never deselect.
      //
      // This used to be "click again = deselect" (`if (state.active === id) postMode('off')`).
      // A trap: as soon as the on-screen active was even slightly stale (or the
      // user just clicked twice to confirm), clicking Claude Code would DESELECT
      // it back to "No agent specified" — every message then went through plain
      // conversation, and what the user saw was "picked claude but it did not
      // take effect". The real-machine log (2026-10-28 10:18:55) shows exactly
      // that: no prior selection record, yet a straight "no agent specified" write.
      //
      // To clear the selection use the explicit "No agent specified" row below —
      // that is the only way out.
      const choose = (id) => {
        act(() => postMode(sessionId, id))
      }

      const list = state && Array.isArray(state.agents) ? state.agents : []
      const enabled = list.filter((a) => a && a.enabled === true)
      // "Installable" = genuinely present on THIS machine but not yet directly
      // invokable (missing recipe / missing env var / missing service).
  //
  // This used to be "everything not enabled" — so machines would list members of
  // the author's roster (codex / draw / video…) that were never installed there,
  // and clicking them did nothing. The user's own words: "what I want from this
  // Installable section is a slot" — the slot should hold what THIS machine
  // detected, not somebody else's list.
  const installable = list.filter((a) => a && a.enabled !== true && a.installed !== false)
  // In the roster but not installed on this machine: takes no list slot, just a
  // one-line note at the end so people know "install it and it appears".
  const absent = list.filter((a) => a && a.enabled !== true && a.installed === false)
      const active = enabled.find((a) => a.id === (state && state.active)) || null
      const label = busy ? 'Switching…' : (active ? active.name : 'No agent specified')

      const rows = []

      // Always first: plain conversation. Structured like an agent row so the
      // choice is explained the same way, minus the remove button (there is
      // nothing to remove).
      const offExpanded = expandedId === OFF_ROW_ID
      rows.push(h('div', {
        key: '__off',
        style: Object.assign({}, rowStyle, active === null ? rowOnStyle : null, { cursor: 'default' }),
      },
        active === null ? h('span', { style: dotStyle }) : h('span', { style: spacerStyle }),
        h('button', {
          type: 'button',
          onClick: () => act(() => postMode(sessionId, 'off')),
          title: 'No default executor: treated as a plain conversation; you can still name an agent ad hoc (affects this session only)',
          style: {
            flex: '1 1 auto', minWidth: 0, textAlign: 'left', border: 'none',
            background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0,
            display: 'flex', flexDirection: 'column', gap: 2,
          },
        },
          h('span', { style: nameStyle }, OFF_LABEL),
          h('span', { style: expertiseStyle }, OFF_EXPERTISE),
          h('span', { style: hintWrapStyle },
            active === null ? 'Current state · plain conversation (zcode\'s own model)' : 'plain conversation (zcode\'s own model)'),
          offExpanded ? h('span', { style: descStyle }, OFF_DESC) : null,
        ),
        h('button', {
          type: 'button',
          onClick: () => setExpandedId(offExpanded ? null : OFF_ROW_ID),
          onMouseEnter: (event) => hoverIn(event, false),
          onMouseLeave: (event) => hoverOut(event, 0.7),
          title: offExpanded ? 'Collapse explanation' : 'Expand explanation: what "No agent specified" means',
          'aria-label': (offExpanded ? 'Collapse ' : 'Expand ') + OFF_LABEL + ' explanation',
          style: Object.assign({}, infoIconStyle, offExpanded ? { opacity: 1 } : null),
        }, offExpanded ? '−' : '?'),
      ))
      if (state === null) {
        rows.push(h('div', { key: '__loading', style: mutedStyle }, error === null ? 'Loading…' : error))
      } else if (enabled.length === 0) {
        // Two different kinds of "empty" must be told apart here:
        //   a) not a single agent was detected → teach the user to install one
        //   b) agents were detected but none is usable yet (missing recipe / credentials) → point at "Installable" below
        // Both cases used to say "no agent CLI detected yet", which for b) is
        // flatly untrue: it did find 3 of them — just none of them is in the
        // enabled list.
        const foundCount = Array.isArray(state.agents) ? state.agents.length : 0
        if (foundCount === 0) {
          rows.push(h('div', { key: '__none', style: mutedStyle }, 'No agent CLI has been detected yet'))
          // Do not hard-code install commands — every vendor's install method
          // churns; a hard-coded command would be wrong within months.
          rows.push(h('div', { key: '__none2', style: hintWrapStyle },
            'This plugin only does the dispatching; it ships no agents. Install one first (Claude Code, Codex, Cursor…), restart zcode, and it appears automatically.'))
        } else {
          rows.push(h('div', { key: '__none', style: mutedStyle },
            'Found ' + foundCount + ' agents, but none can be invoked directly yet'))
          rows.push(h('div', { key: '__none2', style: hintWrapStyle },
            'Expand "Installable" below to see what each one is missing: entries missing credentials say which env var they need; entries missing a launch recipe have a three-step "How do I add one?" guide.'))
        }
      } else {
        for (const entry of enabled) {
          const on = active !== null && active.id === entry.id
          const expanded = expandedId === entry.id
          // Sometimes the intro is exactly the always-visible line above
// (auto-discovered entries put desc into expertise); in that case a second
// "?" toggle would just repeat the same sentence.
const hasDesc = typeof entry.desc === 'string' && entry.desc !== '' && entry.desc !== entry.expertise
          rows.push(h('div', {
            key: entry.id,
            style: Object.assign({}, rowStyle, on ? rowOnStyle : null, { cursor: 'default' }),
          },
            on ? h('span', { style: dotStyle }) : h('span', { style: spacerStyle }),
            h('button', {
              type: 'button',
              onClick: () => choose(entry.id),
              title: entry.installed
                ? 'Set as the default executor'
                : ('Not found: ' + entry.path + ' — still selectable, but invoking it will fail'),
              style: {
                flex: '1 1 auto', minWidth: 0, textAlign: 'left', border: 'none',
                background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0,
                display: 'flex', flexDirection: 'column', gap: 2,
              },
            },
              h('span', { style: nameRowStyle },
                h('span', { style: nameStyle }, entry.name),
                entry.kind === 'chat'
                  ? h('span', {
                    style: Object.assign({}, kindBadgeStyle, kindChatBadgeStyle),
                    title: 'Chat: your message is passed to it verbatim, and its reply is relayed back verbatim',
                  }, 'Chat')
                  : h('span', {
                    style: kindBadgeStyle,
                    title: 'Task: your message is dispatched to it as a task, and the result comes back summarised',
                  }, 'Task'),
              ),
              // Capability summary first — what it is good at matters more to the
              // choice than which tool name backs it.
              entry.expertise
                ? h('span', { style: expertiseStyle }, entry.expertise)
                : null,
              h('span', {
                style: hintWrapStyle,
                // Full text on hover as well, in case the menu is narrow.
                title: (on ? 'Current executor' : (entry.installed ? entry.tool : 'CLI not found'))
                  + (entry.note ? ' · ' + entry.note : ''),
              },
                (on ? 'Current executor' : (entry.installed ? entry.tool : 'CLI not found'))
                + (entry.note ? ' · ' + entry.note : '')),
              expanded && hasDesc
                ? h('span', { style: descStyle }, entry.desc)
                : null,
            ),
            hasDesc
              ? h('button', {
                type: 'button',
                onClick: () => setExpandedId(expanded ? null : entry.id),
                onMouseEnter: (event) => hoverIn(event, false),
                onMouseLeave: (event) => hoverOut(event, 0.7),
                title: expanded ? 'Collapse capability summary' : 'Expand capability summary',
                'aria-label': (expanded ? 'Collapse ' : 'Expand ') + entry.name + ' capability summary',
                style: Object.assign({}, infoIconStyle, expanded ? { opacity: 1 } : null),
              }, expanded ? '−' : '?')
              : null,
            h('button', {
              type: 'button',
              onClick: () => act(() => postDisable(entry.id)),
              onMouseEnter: (event) => hoverIn(event, true),
              onMouseLeave: (event) => hoverOut(event, 0.7),
              title: 'Remove from the list (does not uninstall the CLI)',
              'aria-label': 'Remove ' + entry.name,
              style: removeIconStyle,
            }, '×'),
          ))
        }
      }
      // Collapsed area for agents that are listed but not enabled yet, so a
      // machine with many future agents does not drown the selectable list.
      if (installable.length > 0) {
        rows.push(h('div', {
          key: '__sec', style: secStyle,
          onClick: () => setShowInstallable((v) => !v),
        }, (showInstallable ? '▾ ' : '▸ ') + 'Installable (' + installable.length + ')'))
        if (showInstallable) {
          for (const entry of installable) {
            const helpOpen = recipeHelpId === entry.id
            rows.push(h('div', { key: entry.id, style: Object.assign({}, rowStyle, { cursor: 'default' }) },
              h('span', { style: spacerStyle }),
              h('span', { style: bodyStyle },
                h('span', { style: nameStyle }, entry.name),
                entry.expertise ? h('span', { style: expertiseStyle }, entry.expertise) : null,
                h('span', { style: hintWrapStyle },
                  (entry.installed ? 'CLI in place' : 'CLI not installed') + (entry.note ? ' · ' + entry.note : '')),
                // This section is exactly where the description matters most: it
                // holds "detected but not yet usable" members, and users will only
                // bother adding the launch recipe once they understand what the
                // thing does. Before, only name/expertise/note rendered; desc was
                // stored but not a single character of it was shown.
                entry.desc ? h('span', { style: descStyle }, entry.desc) : null,
                // Detected but no recipe — do not just drop a "needs setup" and
                // walk away. Provide an openable walkthrough: the plugin knows the
                // path and exe itself, so fill them in for the user; they only
                // need one --help check, one argv edit, and a restart.
                entry.needsRecipe
                  ? h('button', {
                    type: 'button',
                    onClick: () => { setRecipeHelpId(helpOpen ? null : entry.id); setCopiedId(null) },
                    style: miniBtnStyle,
                    title: helpOpen ? 'Collapse' : 'Three steps to make it usable',
                  }, helpOpen ? 'Collapse ▲' : 'How do I add one? ▼')
                  : null,
                entry.needsRecipe && helpOpen
                  ? (() => {
                    const sep = String((state && state.conventionDir) || '').includes('\\') ? '\\' : '/'
                    const dir = (state && state.conventionDir) || '.zcode/agent-picker.d'
                    const file = dir + sep + entry.id + '.agent.json'
                    const probe = '"' + entry.path + '" --help'
                    const tpl = JSON.stringify({
                      id: entry.id,
                      name: entry.name,
                      tool: entry.tool,
                      kind: 'task',
                      launch: { bin: entry.path, argv: ['-p', '{task}'] },
                    }, null, 2)
                    const copy = (text) => {
                      try {
                        if (typeof navigator !== 'undefined' && navigator.clipboard) {
                          navigator.clipboard.writeText(text)
                          setCopiedId(entry.id)
                        }
                      } catch { /* no clipboard — they can select and copy manually */ }
                    }
                    return h('span', { style: guideStyle },
                      h('span', { style: guideLineStyle }, 'It is missing a launch recipe — three steps to add one:'),
                      h('span', { style: guideLineStyle }, '1. Check which arguments it accepts:'),
                      h('span', { style: codeStyle }, probe,
                        h('button', { type: 'button', style: miniBtnStyle, onClick: () => copy(probe) },
                          copiedId === entry.id ? 'Copied' : 'Copy')),
                      h('span', { style: guideLineStyle }, '2. Find the one-shot execution flag: --prompt / -p / exec / run or the like'),
                      h('span', { style: guideLineStyle }, '3. Save as this file (id / name / path are filled in for you; you only edit argv):'),
                      h('span', { style: codeStyle }, file + '\n' + tpl,
                        h('button', { type: 'button', style: miniBtnStyle, onClick: () => copy(tpl) },
                          copiedId === entry.id ? 'Copied' : 'Copy template')),
                      h('span', { style: guideLineStyle }, 'After saving, restart zcode and it will appear in the selectable list above.'),
                    )
                  })()
                  : null,
              ),
              // No "+" for members without a recipe: enabling one yields no tool,
              // and only walks the user into the "select it → every other agent is
              // blocked" deadlock (seen on a real machine). The right action for
              // this row is the "How do I add one?" on the left, not "enable".
              entry.needsRecipe ? null : h('button', {
                type: 'button',
                onClick: () => act(() => postEnable(entry.id)),
                onMouseEnter: (event) => hoverIn(event, false),
                onMouseLeave: (event) => hoverOut(event, 0.8),
                title: 'Add to the selectable list',
                'aria-label': 'Enable ' + entry.name,
                style: addIconStyle,
              }, '＋'),
            ))
          }
        }
      }
      // In the roster but not installed on this machine: no names taking up list
      // slots, just one line saying so.
      //
      // This line must sit OUTSIDE both ifs above — when the installable section
      // is empty (another machine is exactly that case) the inner loop never
      // renders, the notice would vanish along with it, and the user would have
      // no idea anything could still be installed.
      if (absent.length > 0) {
        rows.push(h('div', { key: '__absent', style: absentLineStyle },
          'Also ' + absent.length + ' agent(s) not installed on this machine — install and restart zcode, and they will appear here automatically'))
      }

      // "Self-test": have the plugin spawn the current executor itself, no model
      // in the loop.
      //
      // This is exactly what stalled for so long on real machines: the tool was
      // registered and the prompt section said "you must call it", but the model
      // never called it — so "does the plugin/CLI pipeline work" stayed hidden
      // behind "will the model call it". This button separates the two: if it
      // runs clean the pipeline is fine, and whatever remains is the model's side.
      if (state) {
        const activeId = typeof state.active === 'string' ? state.active : null
        const firstEnabled = Array.isArray(state.agents)
          ? (state.agents.find((a) => a && a.enabled === true) || null)
          : null
        const probeId = activeId || (firstEnabled ? firstEnabled.id : null)
        const probeName = probeId
          ? ((Array.isArray(state.agents) && (state.agents.find((a) => a && a.id === probeId) || {}).name) || probeId)
          : null
        rows.push(h('div', { key: '__probeBtn' },
          h('button', {
            type: 'button',
            style: probeBtnStyle,
            disabled: probing === true || probeId === null,
            onClick: () => {
              if (probing === true || probeId === null) return
              act(() => { setProbing(true); setProbe(null) })
              postSelftest(probeId)
                .then((r) => act(() => { setProbe(r); setProbing(false) }))
                .catch((err) => act(() => { setProbe({ ok: false, error: String((err && err.message) || err) }); setProbing(false) }))
            },
          },
            probing === true
              ? 'Self-testing… (up to 90 seconds)'
              : (probeId === null ? 'Self-test: pick an agent first' : 'Self-test ' + probeName + ' (skips the model)'))))

        if (probe) {
          const lines = []
          if (probe.ok === true) {
            lines.push('✓ Pipeline OK: ' + (probe.name || probeId) + ' started and returned')
            lines.push('  exit code ' + probe.exitCode + ' · took ' + probe.ms + 'ms')
            if (probe.stdout) lines.push('  output: ' + String(probe.stdout).slice(0, 200))
          } else {
            lines.push('✗ Pipeline broken' + (typeof probe.exitCode === 'number' ? ' (exit code ' + probe.exitCode + ')' : ''))
            if (probe.error) lines.push('  error: ' + String(probe.error).slice(0, 300))
            if (probe.stderr) lines.push('  stderr: ' + String(probe.stderr).slice(0, 300))
            if (probe.bin) lines.push('  bin: ' + probe.bin)
          }
          rows.push(h('div', { key: '__probeOut', style: probeOutStyle }, lines.join('\n')))
        }
      }

      // Legacy roster left over from an older version: several entries point at
      // launch scripts that do not exist on this machine.
      //
      // The most common cause of "upgraded but nothing seems to have changed":
      // the plugin only seeds when the roster file is absent, the user's 0.4.x
      // roster (11 entries pointing at the author machine's *-zcode.ps1) stays
      // put, so the list still shows that old version and none of the twenty-odd
      // new agents added since appear. Do not delete their file for them (it is
      // their data), but the remedy must be written out right here.
      if (state && typeof state.legacyRoster === 'number' && state.legacyRoster >= 2) {
        rows.push(h('div', { key: '__legacy', style: absentLineStyle },
          'The roster contains ' + state.legacyRoster + ' launch scripts from an older version that point at files missing on this machine.'
          + 'To make the list show only agents actually installed here: delete (or rename) '
          + (typeof state.rosterFile === 'string' ? state.rosterFile : 'agent-picker.agents.json')
          + ' and restart zcode — the plugin will seed a fresh, empty roster.'))
      }

      if (state && typeof state.rosterFile === 'string') {
        rows.push(h('div', { key: '__foot', style: footStyle },
          'Location: ' + state.rosterFile + ' — edit it to add agents'))
      }

      // The bottom-left "how it works" panel: collapsed to one line by default,
      // expands in place when opened.
      //
      // Everything it shows comes from the host's /inspect — not one word is
      // copied here. The reason is practical: the panel exists to answer "what is
      // the model actually being asked to do", and if the client kept its own
      // copy it would eventually drift from the real prompt — and "two versions
      // of the same story" is precisely the failure mode this plugin kept hitting.
      rows.push(h('div', { key: '__inspect', style: inspectBoxStyle },
        h('button', {
          type: 'button',
          onClick: () => {
            const next = !showInspect
            setShowInspect(next)
            if (next) loadInspect()
          },
          title: 'Expand to see the verbatim instructions the model receives and how the executor gate decides',
          'aria-expanded': showInspect,
          style: inspectToggleStyle,
        }, (showInspect ? '▾ ' : '▸ ') + 'How it works: what the model receives'),

        showInspect ? h('div', { style: inspectBodyStyle },
          inspectErr ? h('div', { style: inspectWarnStyle }, inspectErr) : null,
          (inspect === null && inspectErr === null) ? h('div', { style: inspectLabelStyle }, 'Loading…') : null,
          inspect !== null ? h('div', { style: inspectBodyStyle },
            h('div', { style: inspectHeadStyle },
              'This session: ' + (inspect.name
                ? inspect.name + ' (' + (inspect.kind === 'chat' ? 'chat' : 'task') + ')'
                : 'no executor specified')),
            // Point out a memory/disk mismatch on the spot. Normally the two
            // agree; when they diverge, this line beats digging through files.
            inspect.onDisk !== inspect.mode
              ? h('div', { style: inspectWarnStyle },
                '⚠ Memory and disk disagree: disk records ' + JSON.stringify(inspect.onDisk)
                + ', the next turn will use ' + JSON.stringify(inspect.mode))
              : null,
            h('div', { style: inspectLabelStyle }, 'The model receives these instructions every turn (verbatim):'),
            h('pre', { style: inspectPreStyle }, String(inspect.guidance || '')),
            h('div', { style: inspectLabelStyle }, 'Executor gate (checked when a tool is actually invoked):'),
            h('ul', { style: inspectUlStyle },
              (Array.isArray(inspect.gate) ? inspect.gate : []).map((rule, i) => h('li', { key: i }, rule))),
            h('div', { style: inspectLabelStyle }, 'Nature and boundaries:'),
            // Also from the host. No fallback copy on purpose: a fallback is just
            // another copy, and "the panel says something different from reality"
            // is exactly the problem this panel exists to kill.
            (Array.isArray(inspect.notes) && inspect.notes.length > 0)
              ? h('ul', { style: inspectUlStyle },
                inspect.notes.map((note, i) => h('li', { key: i }, note)))
              : null,
          ) : null,
        ) : null,
      ))
      return h('div', { ref: boxRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          disabled: sessionId === null,
          onClick: () => { setOpen((v) => !v); if (!open) reload() },
          title: sessionId === null
            ? 'This control is only available inside a session (no session id)'
            : (active
              ? ('Default executor for this session: ' + active.name + ' (every message is dispatched to it automatically) — affects this session only; a switch takes effect from the next message')
              : 'Choose the default executor (an external agent) for this session — affects this session only; a switch takes effect from the next message'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          style: Object.assign(
            {},
            buttonStyle,
            active ? buttonOnStyle : null,
            sessionId === null ? { opacity: 0.5, cursor: 'not-allowed' } : null,
          ),
        },
          active ? h('span', { style: Object.assign({}, dotStyle, { display: 'inline-block' }) }) : null,
          label,
          h('span', { style: { marginLeft: 2, fontSize: 10, opacity: 0.7 } }, '▾'),
        ),
        open ? h('div', { role: 'menu', style: menuStyle }, rows) : null,
      )
    }

    /** Mount the mode control into the composer's right tool row. */
    exports.apply = function apply(ctx) {
      try {
        ctx.effect(
          () => ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              { name: 'conversation.input.right', id: 'agent-picker', order: 90, label: 'Agent mode' },
              AgentModeButton,
            ),
          ),
          'zcode-agent-picker: composer mode control',
        )
      } catch (error) {
        console.warn('[zcode-agent-picker] mount failed:', error)
      }
    }

    return module.exports
  },
})

