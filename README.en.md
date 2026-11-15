# dsh-observer · Sidecar Observer

A **second model** narrates the main conversation's progress in a floating panel:
what it just did, what it is about to do, and whether it is stuck.
It only reads the session event stream and never injects anything into the main
conversation — **it does not interfere with the main agent**.

## The problem

During long tasks the DSH agent calls tools dozens of times in a row and the UI
just says "Deep diving…". You have no idea how far it got or whether it is stuck.

`dsh-observer` subscribes to `session/event` on the host side, feeds the recent
progress to a **sidecar model** at your chosen interval, and renders a short
narration in a floating panel. You can also ask it follow-up questions right there.

## Features

- **Two entry points**
  - **"观察" (Observer) tab** next to Chat / Files / Context at the top of the conversation.
  - **Floating panel** at the bottom-left of the conversation (above the composer);
    draggable, collapsible into a small pill, position persisted in localStorage.
- **Overlay toggles**: turn the floating panel off (keep only the tab); a separate
  mobile toggle is **off by default**, so narrow screens show no overlay.
- **Model selection**
  - Existing provider: pick provider / model / reasoning effort
    (low / medium / high / xhigh / max, depending on the model).
  - Custom endpoint: base URL + API key + model id (OpenAI-compatible `/chat/completions`).
- **Interval**: never / 30 / 60 / 120 / 180 / 300 / 600 seconds, each labelled with
  an estimated token cost per hour. "Never" keeps manual narration only.
- **Narrate now**: one click to get a fresh narration without waiting for the next tick.
- **Follow-up input**: ask "what is the main conversation doing now?" / "is it stuck?"
  and it answers from the event stream.
- **Thinking switch**: on by default. When on, the sidecar model also sees the main
  model's recent reasoning snippets, so "what's next" is more accurate.
- **Dark / light theme**: uses DSH theme tokens only.
- **Works behind a reverse proxy**: no loopback assumptions, no extra auth layer.

## Install

```bash
# 1. Put the plugin directory anywhere, e.g. /data/dsh/home/nya/dsh-observer
# 2. Install into a profile
dsh plugin --profile web add /data/dsh/home/nya/dsh-observer
# 3. Restart DSH (new bundles can hot-load, but a restart is the safest)
```

Or with the `plugin_manager` tool:

```
plugin_manager action=install_bundle target=/data/dsh/home/nya/dsh-observer
```

Refresh the page afterwards: the "● 旁路观察" pill appears at the bottom-left and
an "观察" tab appears next to Chat.

## Configuration

Open the pill → ⚙ settings:

| Item | Description |
| --- | --- |
| Model source | "Existing provider" or "Custom endpoint" |
| Provider / model | from `ctx.llm.listProviders()` / `listModels()` |
| Reasoning effort | from `ctx.llm.resolveModelInfo()`'s `reasoning.efforts` |
| Interval | never / 30–600 s, with estimated tokens/hour |
| Read main reasoning | on by default; off = text and tool calls only |
| Enable narration | master switch; manual ↻ still works when off |
| Show overlay | on by default; off keeps only the Observer tab |
| Show overlay on mobile | off by default |

Changes in the settings panel **only take effect after clicking Save**; an
"未保存" (unsaved) hint appears at the bottom otherwise.

Config lives in `$DSH_HOME/observer/config.json`; the custom-endpoint API key lives
in `$DSH_HOME/observer/secret.json` (0600). **The plugin never writes the profile's
`cordis.patch.yml`.**

## How it works

```
main session ──session/event──▶ host-side observer plugin
                                   │  keeps the last N events (text / reasoning / tool calls / results)
                                   ▼
                             ctx.llm.stream({ provider, model, ... })  ← sidecar model
                                   │
                                   ▼
                             /api/observer/state  ← browser polls (2 s)
                                   │
                                   ▼
                             floating panel / Observer tab
```

- Auto-narration only while the main session is `running`; it stops after the turn ends.
- Subagent sessions (`origin === 'subagent'`) are skipped.
- Sidecar calls time out after 45 s; failures are recorded and never affect the main session.
- Follow-ups go through `/api/observer/ask` and also only read the event stream.

## HTTP API

| Path | Method | Description |
| --- | --- | --- |
| `/api/observer/state` | GET | current session, latest narration, token totals |
| `/api/observer/config` | GET/POST | read / write config |
| `/api/observer/models` | GET | providers and models |
| `/api/observer/model` | GET | reasoning efforts for one model |
| `/api/observer/now` | POST | force one narration |
| `/api/observer/ask` | POST | follow-up question |
| `/api/observer/health` | GET | health check |

## Known limitations

- The sidecar model only sees what is visible in the event stream (text, reasoning
  snippets, tool names and results). It cannot see the main model's hidden state,
  so "what's next" is an inference and may be wrong.
- Narration is delayed: after the interval elapses it waits for the next tick (5 s).
- Higher frequency costs more tokens; the 30 s option can reach ~400k tokens/hour on
  long tasks (shown in the settings panel).
- Web only.

## Version history

- **v1**: host event collection + sidecar call + HTTP API + floating panel skeleton, end to end.
- **v2**: positioning fix (anchor to composer), drag no longer swallows clicks, settings panel, dark-mode button contrast, token accounting.
- **v3**: narration block visuals, empty state, pill hover, expanded-card height clamp, mobile re-test.
- **v4**: code-reviewer fixes (exponential backoff on failure, `resolveModelInfo`, abort detection, `/now` error feedback, SSRF validation, concurrency mutex, end-of-turn narration); ux-reviewer fixes (mobile no longer covers the composer, drag clamped to viewport, pill is a keyboard-operable button with Esc, tertiary→secondary grey, dark Toggle/Segmented contrast, hover rules moved from inline to CSS, touch targets ≥32 px, focus ring, scroll fade, single settings header).
- **v5**: installed into the main profile and verified remotely; main profile switched to deepseek-account.
- **v6**: Observer tab (`conversation.view`, order 26), overlay toggle (on by default), mobile overlay toggle (off by default), "never" interval, "narrate now" button; model-source switch now requires Save (unsaved hint); overlay hides while the Observer tab is active.

## License

MIT
