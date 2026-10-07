import type { AgentInfo, CommandSpec, PaneOpenArgs, ProcessRunResult, PromptFillArgs, SessionUsage, TimerCall } from 'claude-code'

import type { ReaderFs } from './reader/snapshot'

/** What `$.ui.open` answers: drawn, or held back undrawn with the reason. A build that answers nothing has drawn it. */
export type OpenResult = { isPlaced: boolean; reason?: string } | void

/**
 * The engine as `session.start` bound it from its `$`. Every later hook, timer and button press reaches the engine
 * through this, so everything else is plain functions over a small interface a test can stand in for. Each member may
 * be refused (an administrator removed the affordance, or a policy mod above this one said no): callers catch.
 */
export type Host = {
  fs: ReaderFs
  now: () => Promise<number>
  after: TimerCall
  every: TimerCall
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  invalidate: () => void
  toast: (text: string, timeoutMs?: number) => void
  log: (text: string) => void
  openPane: (pane: PaneOpenArgs) => Promise<OpenResult>
  closePane: (id: string) => Promise<void>
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  fillPrompt: (input: PromptFillArgs) => Promise<{ isFilled: boolean }>
  run: (argv: readonly string[], timeoutMs: number) => Promise<ProcessRunResult>
  usage: () => Promise<SessionUsage>
  agents: () => Promise<AgentInfo[]>
}
