import { takeKept } from '../field-keep'
import { countOf, showFull, SHOW_LINES } from '../full-text'
import type { State } from '../state'
import type { Kit } from './common'

const longs = new WeakMap<State, Set<string>>()

/** The keys of the fields whose text is, as last typed, longer than a line (so their echo is drawn). */
function longOf(state: State): Set<string> {
  let found = longs.get(state)

  if (found === undefined) {
    found = new Set()
    longs.set(state, found)
  }

  return found
}

/** What `withClearing` needs to show a long entry in full while it is typed: the pane width and a way to redraw. */
export type Echo = { columns: number; repaint: () => void }

/**
 * The host's Input is one line: text longer than the field scrolls out of sight. Under an Input whose text is longer than a line, the
 * whole text is shown wrapped (ADR-481), so a person sees all of what they typed and what Enter will send. Short text changes nothing:
 * the Input is returned as it was.
 */
function withEcho(kit: Kit, input: ReturnType<NonNullable<Kit['Input']>>, key: string, label: string | undefined, text: string, columns: number): ReturnType<NonNullable<Kit['Input']>> {
  const lineWidth = Math.max(12, columns - 6)

  if (countOf(text) <= Math.max(10, lineWidth - 8 - (label?.length ?? 0))) return input

  const shown = showFull(text, lineWidth, { maxLines: SHOW_LINES, hint: 'all of it is still in the field above and is sent whole' })

  return kit.Box({
    key: `${key}-full`,
    flexDirection: 'column',
    flexGrow: 1,
    children: [input, ...shown.lines.map(line => kit.Text({ dimColor: true, children: ` ${line}` }))],
  })
}

/**
 * Makes every one-shot entry field clear when Enter is pressed. A field that passes its own `value` is a form field its
 * caller owns (a memory key, a search the buttons beside it use) and is left alone; every other field is drawn from
 * `state.fieldText`, filled as the person types and emptied after its submit, so what was entered never lingers.
 * With `echo`, a long entry (either kind) is also shown in full under its field.
 */
export function withClearing(kit: Kit, state: State, clear: (key: string) => void, echo?: Echo): Kit {
  const Input = kit.Input

  if (Input === undefined) return kit

  return {
    ...kit,
    Input: props => {
      if (props.value !== undefined) {
        const own = Input(props)

        return echo === undefined ? own : withEcho(kit, own, props.key, props.label, props.value, echo.columns)
      }

      const current = state.fieldText.get(props.key) ?? ''
      const drawn = Input({
        ...props,
        value: current,
        onInput: (value, e) => {
          const wasLong = longOf(state).has(props.key)
          const isLong = echo !== undefined && countOf(value) > Math.max(10, Math.max(12, echo.columns - 6) - 8 - (props.label?.length ?? 0))

          state.fieldText.set(props.key, value)
          if (isLong) longOf(state).add(props.key)
          else longOf(state).delete(props.key)
          props.onInput?.(value, e)
          // Only a field that is, or just stopped being, long needs the echo redrawn.
          if (echo !== undefined && (isLong || wasLong)) echo.repaint()
        },
        onSubmit: (value, e) => {
          props.onSubmit?.(value, e)
          longOf(state).delete(props.key)
          // A refused entry (over a real limit) was put back by the action: it stays for the person to edit.
          if (takeKept(state, value)) state.fieldText.set(props.key, value)
          else clear(props.key)
        },
      })

      return echo === undefined ? drawn : withEcho(kit, drawn, props.key, props.label, current, echo.columns)
    },
  }
}
