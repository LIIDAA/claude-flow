/**
 * A refused entry stays in its field (ADR-481). Every one-shot field empties after its Enter (views/clearing.ts); when the text was refused
 * (it is over a real limit) the person must not lose it, so the refusing action marks the exact text `kept`, and the field puts it back
 * instead of emptying. Keyed by the text, not the field: the action does not know which field (page or menu strip) it came from.
 */
import type { State } from './state'

const kept = new WeakMap<State, Set<string>>()

const keptOf = (state: State): Set<string> => {
  let found = kept.get(state)

  if (found === undefined) {
    found = new Set()
    kept.set(state, found)
  }

  return found
}

/** Marks `text` (exactly as the field submitted it) as refused: the field keeps it. */
export function keepText(state: State, text: string): void {
  keptOf(state).add(text)
}

/** True once after `keepText` for this text: the field then keeps it instead of clearing. */
export function takeKept(state: State, text: string): boolean {
  return keptOf(state).delete(text)
}
