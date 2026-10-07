import type { ModState } from '../state'
import { createToastKit, type ToastInput } from './policy'

/**
 * The mod's toasts (ADR-477): every `$.ui.toast` of ruflo-mods goes through the shared policy (levels, one clean line, de-duplication, a
 * rate limit, the person's Toasts setting from the console, and a digest on the console's Events page). The engine `$` cannot be passed
 * across an import, so `registerNoun` binds the calls from the `$` built beneath (as it does `ui.status`) and hands them here as functions.
 * The result never rejects and never throws: a refused toast changes no verdict, answer or hook result.
 */
export type ToastBinding = {
  now: () => Promise<number>
  show: (line: string, options: { timeoutMs?: number }) => void
  after: (ms: number, fn: () => void) => unknown
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

export function bindToasts(state: ModState, bound: ToastBinding): void {
  const toaster = createToastKit({ source: 'mods', now: bound.now, show: bound.show, after: bound.after, io: { read: bound.read, write: bound.write, exists: bound.exists } })

  state.say = async (input: ToastInput) => {
    try {
      await toaster.toast(input)
    } catch {
      // a toast never changes what the hook answers
    }
  }
}
