# 0.1.2 — Desktop-style team workspace

- Reworked the ChatGPT board into a compact ruOS-inspired desktop with window chrome, workspace rail, status indicators, run metrics, task rows, and responsive narrow-width layout.
- Versioned the MCP Apps resource URI to `ui://ruflo-ai-team/board-v2.html` so hosts refresh the cached UI.
- Kept all content read-only and rendered with text nodes; no external scripts, frames, or network requests were added.

# 0.1.1 — ChatGPT team board and run completion

- Added a read-only ChatGPT team board with ruOS-inspired styling through an MCP Apps HTML resource. Tenant data is returned only by the OAuth-scoped `team_board` tool.
- Added `run_complete`, guarded by `team:run` and completion of all tasks, so evidence exports can show a completed run.
- Kept the RuVector fallback explicit while the pinned native binding fails its dimension self-test; native search is not claimed as verified.

# 0.1.0 — Initial review candidate

- New multi-tenant RuFlo AI Team MCP service, separate from RuFlo Federation.
- Twelve focused tools for templates, teams, runs, tasks, tenant-local memory, and evidence.
- OAuth 2.1 resource-server discovery with strict issuer, audience, scope, and tenant binding.
- Firestore canonical storage plus bounded per-tenant/team RuVector derived indexes.
- Six workflow skills, four specialized agents, four commands, two MCP prompts, and one template resource.
- Complete explicit tool annotations, secret-free schemas, cross-tenant denial tests, untrusted-content fencing, legal pages, Docker packaging, and Cloud Run manifest.

Known boundary: v0.1 coordinates and verifies work but does not dispatch paid models, provision desktops, execute arbitrary commands, send messages, deploy, purchase, publicly share, or delete tenant data.
