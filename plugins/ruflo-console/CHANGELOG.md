# Changelog: ruflo-console

Newest first. One `## <version> — <date>` heading per version, then `feat:`, `fix:`, `breaking:` and `chore:` bullets (ADR-478). Built from git history; older versions: `git log -- plugins/ruflo-console`.

## 0.39.0 — 2026-10-07
- feat: ADRs page under TOOLS: find, propose, accept, reject, deprecate and supersede your own project's Architecture Decision Records, with the exact file and diff in the confirm (ADR-480)
- feat: the page finds your project's ADR folder (docs/adr, docs/adrs, doc/adr, adr, docs/architecture/decisions, docs/decisions ...) or the one in Settings, follows the style of your existing ADRs (MADR, Nygard / adr-tools, ruflo style) and offers to initialise a project that has none
- feat: attach ADRs to a mission: Claude's mission context, the task instruction and spawned swarm agents carry the accepted decisions; changed files are compared with the paths those ADRs name at verify time (a warning in the record, never a block)
- feat: ADR lint (duplicate numbers, dangling or one-sided supersedes, no status or date, missing from the index, broken links); palette entries adr-propose, adr-accept, adr-supersede and more, at the write control level
- feat: Settings gain ADR folder, ADR style and ADR file name pattern

## 0.38.0 — 2026-10-07
- feat: What’s new page under TOOLS: each installed ruflo plugin’s bundled CHANGELOG.md, newest first, with a divider at the last look, breaking changes pinned until dismissed, a new marker on the nav, and one info toast per new version (ADR-478)
- feat: CHANGELOG.md in every plugin, in a fixed format the page parses; the smoke contract checks it for console, mods, swarm and protector
- chore: Settings, Events and update-check ADRs brought up to date; ADR-479 for the MCP HTTP bearer token
- fix: a toast needs no engine.create (bind at session.start too), a throwing clock falls back to the wall clock; update the cost ladder expectati…
- fix: console toasts release held errors on a timer; settings section names toasts; ADR wording

## 0.37.0 — 2026-10-07
- feat: shared toast system with levels, dedupe, persistence and Settings (ADR-477)
- feat: shared toast policy and its call sites (ADR-477), work in progress
- fix: CONSOLE_VERSION follows the manifest (0.36.1)

## 0.36.1 — 2026-10-07
- feat: Settings puts Claude control and spending first, folds ruflo config and plugin options to the end

## 0.36.0 — 2026-10-07
- feat: 0.36.0 integration: eventsPersist option, shared whole-batch append argv, hostile-time hardening, init ignores console/
- fix: log Claude's refused request when the person's card is waiting; mission-auto why when not wired; document the local-read allowlist
- fix: session control cap, gate on read-only entries that act, hostile text/data, mission auto-run guards (#3814 #3815 #3816 #3817 #3818)
- chore: Merge verify/events-0.36 into feat/console-0.36

## 0.35.0 — 2026-10-06
- feat: autopilot envelope editor, parallel hand-over, spend windows, band segment, and the first live run (ADR-470)
- feat: recorded recalls, real vectors on the memory map, log-based stale (ADR-472)
- fix: control plane measured in an interactive session (ADR-471)
- fix: Workflows layout at every dock width, replay play loop, quiet stale presses (ADR-469)
- chore: 0.35.0; re-sign the helpers manifest for the recall-log hook changes (ADR-472)
- chore: incremental transcript parsing, kit-seq runner, tsc clean for specs (ADR-473)

## 0.34.1 — 2026-10-06
- feat: wire control plane, conversation and mission autopilot into the Workflows page (ADR-465, ADR-466)
- feat: interactive control plane and multi-model bridge (ADR-465)
- feat: control tab, Conversation board, truthful stop/message wording (ADR-465 wip)
- feat: autopilot live loop, panel, parked queue and tests (ADR-466)
- feat: conversation model, transports, tests with fake transports (ADR-465 wip)
- feat: autopilot pure core - envelope, journal, step machine, adapt gate, guards (ADR-466)
- feat: control plane data (stop, message, redirect), targets registry, send transports (ADR-465 wip)
- feat: merge the five Workflows features and wire their seams (ADR-459..463)
- chore: and 38 more changes (git log -- plugins/ruflo-console)

## 0.33.23 — 2026-10-05
- feat: band notices, tone border, /ruflo band|notices|quiet (0.33.23)
- feat: Project Anatole section in Security & Doctor (0.33.23)
- fix: keep the Router's running-success curve (an existing test and feature); only explain why it is empty
- fix: the Router block says why it is empty and does not stretch a flat curve over nine outcomes
- fix: the Learning pulse charts mean one thing each and line up (0.33.22)
- fix: smoke step 12 accepts the excluded list as well as the CI baseline for kit tests
- fix: status.json carries version 1 and the *Ms times the Mods scan needs; the console maps the plugin to Security & Doctor
- fix: the Optimizer's answer panel is framed like every other result
- chore: and 3 more changes (git log -- plugins/ruflo-console)

## 0.33.24 — 2026-10-05
- feat: the band shows how long Claude has been working, the tool-call rhythm and the context gauge (0.33.24)
