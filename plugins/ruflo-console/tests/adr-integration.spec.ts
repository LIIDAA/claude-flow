/**
 * The ADRs page and its reach into missions, loops and swarms (ADR-480): attach, suggest and detach on a mission; the digest in the
 * mission context, in the task instruction and in the file the swarm reads; the scope check against a real git repository; the page in
 * both looks; the palette entries and the control level each needs; the settings. Run with
 *   npx vitest run plugins/ruflo-console/tests/adr-integration.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { adrActions, adrBlockFor, adrOf, attachedDocs, attachedOf, DIGEST_FILE, draftSpec, loadAdrs, mirrorDigest, scopeCheck, setAttached, suggestFor } from '../hooks/adr'
import { adrPalette } from '../hooks/adr-palette'
import { allows, classOf } from '../hooks/model-tools'
import { contextSection, claudeActions } from '../hooks/mission-claude'
import { missionContextText } from '../hooks/mission-context'
import { instructionOf, loadLedger, LEDGER_KEY, mcOf } from '../hooks/mission-control'
import type { MissionRecord } from '../hooks/mission-types'
import { paletteEntries } from '../hooks/palette'
import { loadAiPrefs, saveAiPrefs, settingsOf } from '../hooks/settings'
import { newState, VIEWS, type State } from '../hooks/state'
import { NAV_GROUPS } from '../hooks/nav-state'
import { setLook, type Actions } from '../hooks/views/common'
import { viewText } from '../hooks/views/pane'
import { adrsView } from '../hooks/views/adr'
import { readAdrDigest } from '../../ruflo-swarm/hooks/adr-digest'
import { hostOfRoot, tempProject } from './adr-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'adr-projects')
const cleanups: string[] = []

afterAll(() => {
  setLook('plain')
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

const TASK = { id: 't1', title: 'Move sessions', phase: 'refinement', agent: 'coder', requirement: 'sessions live in the new store', dependsOn: [] }
const missionOf = (patch: Partial<MissionRecord> = {}): MissionRecord => ({ id: 'msn_aaaaaaaaaaaaaaaaaaaaaaaa', objective: 'Move the graphql api sessions in api/public', profile: 'feature', rigor: 'standard', tasks: [TASK], acceptance: [{ id: 'a1', check: 'tests pass' }], events: [], paused: false, cancelled: false, auto: false, createdAtMs: Date.now() - 3_600_000, ...patch })

async function world(name: string, mission: Partial<MissionRecord> | null = {}) {
  const root = tempProject(FIXTURES, name)

  cleanups.push(root)

  const state = newState({})
  const hosted = hostOfRoot(root)
  const stored = new Map<string, unknown>()
  const host = { ...hosted.host, storeSet: async (key: string, value: unknown) => void stored.set(key, value), storeGet: async (key: string) => stored.get(key) }

  state.cwd = root
  state.isInteractive = true

  if (mission !== null) {
    const record = missionOf(mission)

    mcOf(state).missions.set(record.id, record)
    mcOf(state).active = record.id
  }

  await loadAdrs(state, host as never)

  return { root, state, host, stored, log: hosted.log, mission: mission === null ? null : (mcOf(state).missions.get('msn_aaaaaaaaaaaaaaaaaaaaaaaa') as MissionRecord) }
}

describe('attach, suggest and detach on a mission', () => {
  it('attaches by file, saves the ledger, refuses what is not an ADR here, caps the number and detaches', async () => {
    const { state, host, mission, stored } = await world('nygard')
    const m = mission as MissionRecord

    await setAttached(state, host as never, '0003-use-graphql.md', true)
    await setAttached(state, host as never, '0003-use-graphql.md', true)
    expect(attachedOf(m)).toEqual(['0003-use-graphql.md'])
    expect((stored.get(LEDGER_KEY) as { missions: MissionRecord[] }).missions[0]?.adrs).toEqual(['0003-use-graphql.md'])
    expect(m.events.filter(event => event.type === 'adr.attached')).toHaveLength(2)

    await setAttached(state, host as never, '../../etc/passwd', true)
    await setAttached(state, host as never, 'nope.md', true)
    expect(adrOf(state).last?.ok).toBe(false)
    expect(attachedOf(m)).toEqual(['0003-use-graphql.md'])
    await setAttached(state, host as never, '0003-use-graphql.md', false)
    expect(attachedOf(m)).toEqual([])
  })

  it('with no active mission there is nothing to attach to, and it says so', async () => {
    const { state, host } = await world('nygard', null)

    await setAttached(state, host as never, '0003-use-graphql.md', true)
    expect(adrOf(state).last).toMatchObject({ ok: false })
    expect(adrOf(state).last?.lines[0]).toContain('no active mission')
  })

  it('suggests from the goal (a suggestion only: nothing is attached until the person presses)', async () => {
    const { state, mission } = await world('nygard')
    const suggested = suggestFor(state, mission, (mission as MissionRecord).objective)

    expect(suggested.map(s => s.doc.number)).toEqual([3])
    expect(suggested[0]?.why).toContain('api/public')
    expect(attachedOf(mission as MissionRecord)).toEqual([])
  })

  it('a saved ledger is not trusted: hostile attached names are dropped on load', async () => {
    const { state, host } = await world('nygard', null)
    const bad = missionOf({ adrs: ['../../x.md', 'ok.md', 7 as never, 'a/b.md', 'x'.repeat(300) + '.md'] })

    await host.storeSet(LEDGER_KEY, { active: bad.id, missions: [bad] })
    await loadLedger(state, host as never)
    expect(mcOf(state).missions.get(bad.id)?.adrs).toEqual(['ok.md'])
  })
})

describe('the digest reaches Claude, the task instruction and the swarm', () => {
  it('rides in the mission context Claude reads, with the accepted decision, and not when nothing is attached', async () => {
    const { state, host } = await world('nygard')
    const before = contextSection(state)

    expect(before?.text).not.toContain('Decisions attached')
    await setAttached(state, host as never, '0003-use-graphql.md', true)

    const after = contextSection(state)

    expect(after?.id).toBe('ruflo-console:mission')
    expect(after?.text).toContain('Decisions attached to this work')
    expect(after?.text).toContain('ADR 3 [accepted] Use GraphQL for the public API')
    expect(after?.text).toContain('GraphQL, in `api/public/`.')
    expect(after?.text).toContain('Mission msn_')
  })

  it('is cached: the same section text until an attached record’s status changes', async () => {
    const { state, host, root } = await world('nygard')

    await setAttached(state, host as never, '0003-use-graphql.md', true)
    expect(contextSection(state)?.text).toBe(contextSection(state)?.text)

    const first = contextSection(state)?.text

    writeFileSync(join(root, 'doc/adr/0003-use-graphql.md'), readFileSync(join(root, 'doc/adr/0003-use-graphql.md'), 'utf8').replace('## Status\n\nAccepted', '## Status\n\nDeprecated'))
    await loadAdrs(state, host as never)
    expect(contextSection(state)?.text).not.toBe(first)
    expect(contextSection(state)?.text).toContain('(history, no longer in force)')
  })

  it('is capped and masked: a huge decision and a secret in an ADR never reach the prompt whole', async () => {
    const { state, host, root } = await world('nygard')
    const secret = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

    for (let i = 4; i < 14; i += 1) writeFileSync(join(root, 'doc/adr', `00${String(i).padStart(2, '0')}-big-${i}.md`), `# ${i}. Big ${i}\n\nDate: 2025-01-01\n\n## Status\n\nAccepted\n\n## Decision\n\n${'We decide many things here. '.repeat(500)} token: ${secret}\n`)
    await loadAdrs(state, host as never)
    for (let i = 4; i < 14; i += 1) await setAttached(state, host as never, `00${String(i).padStart(2, '0')}-big-${i}.md`, true)

    const text = contextSection(state)?.text ?? ''

    expect(attachedOf(mcOf(state).missions.get('msn_aaaaaaaaaaaaaaaaaaaaaaaa') as MissionRecord)).toHaveLength(8)
    expect(text.length).toBeLessThan(1200 + 1400)
    expect(text).not.toContain(secret)
    expect(text).toMatch(/… and \d+ more not shown|ADR 4 \[accepted\]/)
  })

  it('is in the instruction handed to the task, ahead of the completion rule', async () => {
    const { state, host, mission } = await world('nygard')

    await setAttached(state, host as never, '0003-use-graphql.md', true)

    const text = instructionOf(mission as MissionRecord, TASK, adrBlockFor(state, mission))

    expect(text).toContain('Decisions attached to this work')
    expect(text.indexOf('Decisions attached')).toBeLessThan(text.indexOf('When this task is finished'))
    expect(instructionOf(mission as MissionRecord, TASK)).not.toContain('Decisions attached')
    expect(missionContextText(mission as MissionRecord, TASK, null, 'ready', 'BLOCK')).toMatch(/\nBLOCK$/)
  })

  it('is mirrored to the file the swarm reads, masked and capped, and cleared when nothing is attached', async () => {
    const { state, host, root } = await world('nygard')

    await setAttached(state, host as never, '0003-use-graphql.md', true)

    const body = JSON.parse(readFileSync(join(root, DIGEST_FILE), 'utf8')) as { v: number; block: string; adrs: { number: number }[] }

    expect(body.v).toBe(1)
    expect(body.adrs).toEqual([{ number: 3, file: '0003-use-graphql.md', status: 'accepted' }])

    const swarmFs = { read: async (path: string) => readFileSync(join(root, path), 'utf8'), stat: async (path: string) => (existsSync(join(root, path)) ? { size: readFileSync(join(root, path)).length } : undefined) }
    const digest = await readAdrDigest(swarmFs, Date.now())

    expect(digest?.numbers).toEqual([3])
    expect(digest?.block).toContain('GraphQL')
    expect(await readAdrDigest(swarmFs, Date.now() + 3 * 86_400_000)).toBeNull()

    await setAttached(state, host as never, '0003-use-graphql.md', false)
    expect(await readAdrDigest(swarmFs, Date.now())).toBeNull()
    expect(await mirrorDigest(state, host as never)).toBeNull()
  })

  it('the swarm ignores a digest that is oversize, malformed or from a hostile writer', async () => {
    const files: Record<string, string> = {}
    const fs = { read: async (path: string) => files[path] ?? Promise.reject(new Error('x')), stat: async (path: string) => (files[path] === undefined ? undefined : { size: files[path]?.length }) }
    const path = '.claude-flow/console/adr-digest.json'
    const ok = { v: 1, atMs: 1_000, mission: 'm', adrs: [{ number: 1, status: 'accepted' }, { number: '2', status: 'accepted' }, { number: 3, status: 'proposed' }], block: 'Decisions\n- ADR 1 [accepted] A\u001b[31m' }

    files[path] = JSON.stringify(ok)
    expect(await readAdrDigest(fs, 2_000)).toEqual({ block: 'Decisions\n- ADR 1 [accepted] A', numbers: [1] })

    for (const bad of ['{nope', JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, block: '' }), JSON.stringify({ ...ok, atMs: 'x' }), 'x'.repeat(40_000), JSON.stringify([1])]) {
      files[path] = bad
      expect(await readAdrDigest(fs, 2_000), bad.slice(0, 20)).toBeNull()
    }
  })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })

describe('the scope check against a real repository', () => {
  async function repo(adrFiles: Record<string, string> = {}) {
    const w = await world('empty')

    mkdirSync(join(w.root, 'src/auth'), { recursive: true })
    mkdirSync(join(w.root, 'src/authz'), { recursive: true })
    mkdirSync(join(w.root, 'docs/adr'), { recursive: true })
    writeFileSync(join(w.root, 'src/auth/login.ts'), 'a')
    writeFileSync(join(w.root, 'src/authz/x.ts'), 'a')
    writeFileSync(join(w.root, 'docs/adr/0001-sessions.md'), '# 1. Sessions\n\nDate: 2025-01-01\n\n## Status\n\nAccepted\n\n## Decision\n\nSessions, in `src/auth/`.\n')
    writeFileSync(join(w.root, 'docs/adr/0002-tokens.md'), '# 2. Tokens\n\nDate: 2025-01-01\n\n## Status\n\nProposed\n\n## Decision\n\nTokens, in `src/auth/`.\n')
    for (const [name, text] of Object.entries(adrFiles)) writeFileSync(join(w.root, 'docs/adr', name), text)
    git(w.root, 'init', '-q')
    git(w.root, 'add', '-A')
    git(w.root, 'commit', '-q', '-m', 'init')
    await loadAdrs(w.state, w.host as never)
    ;(w.mission as MissionRecord).createdAtMs = Date.now() + 60_000

    return w
  }

  it('warns on a changed file under an accepted attached ADR’s path, and records it as mission evidence, never a block', async () => {
    const w = await repo()

    await setAttached(w.state, w.host as never, '0001-sessions.md', true)
    writeFileSync(join(w.root, 'src/auth/login.ts'), 'changed')
    writeFileSync(join(w.root, 'src/authz/x.ts'), 'changed')

    const lines = await scopeCheck(w.state, w.host as never)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^warning: 1 changed file in the scope of ADR 1 .*src\/auth\/login\.ts/)
    expect(lines[0]).not.toContain('authz')
    expect((w.mission as MissionRecord).events.find(event => event.type === 'adr.scope')?.note).toContain('warning')
  })

  it('does not warn on an unrelated change, on a proposed ADR, or on a sibling path that shares a prefix', async () => {
    const w = await repo()

    await setAttached(w.state, w.host as never, '0001-sessions.md', true)
    await setAttached(w.state, w.host as never, '0002-tokens.md', true)
    writeFileSync(join(w.root, 'src/authz/x.ts'), 'changed')
    writeFileSync(join(w.root, 'README.md'), 'new')

    const lines = await scopeCheck(w.state, w.host as never)

    expect(lines.some(line => line.startsWith('warning'))).toBe(false)
    expect(lines.join('\n')).toContain('compares paths only')
    expect(lines.join('\n')).toContain('not checked: ADR 2 is proposed')
  })

  it('sees commits made since the mission began, not only uncommitted work', async () => {
    const w = await repo()

    await setAttached(w.state, w.host as never, '0001-sessions.md', true)
    ;(w.mission as MissionRecord).createdAtMs = Date.now() - 3_600_000
    writeFileSync(join(w.root, 'src/auth/login.ts'), 'committed')
    git(w.root, 'commit', '-q', '-am', 'change login')

    const lines = await scopeCheck(w.state, w.host as never)

    expect(lines[0]).toContain('src/auth/login.ts')
  })

  it('the verify action runs the gates, then adds the ADR scope to the record without changing the gates’ result', async () => {
    const w = await repo()

    await setAttached(w.state, w.host as never, '0001-sessions.md', true)
    writeFileSync(join(w.root, 'src/auth/login.ts'), 'changed')
    settingsOf(w.state).ai.loopGates = 'true'

    let spec: { run?: () => Promise<void> } | null = null
    const runner = { ask: (s: typeof spec) => void (spec = s) }

    claudeActions(w.state, w.host as never, runner as never).verify()
    await (spec as { run: () => Promise<void> } | null)?.run()
    expect(mcOf(w.state).last?.ok).toBe(true)
    expect(mcOf(w.state).last?.detail).toContain('all 1 passed; ADR scope: 1 warning in the record')
    expect((w.mission as MissionRecord).events.map(event => event.type)).toContain('adr.scope')
  })

  it('a draft ADR from the mission is a normal confirm, pre-filled from the goal, written only on Yes', async () => {
    const w = await repo()
    const spec = draftSpec(w.state, w.host as never, '2026-10-07')

    expect(spec?.label).toContain('propose ADR 3: Move the graphql api sessions in api/public')
    expect(spec?.shows).toContain('+Draft, written from the mission')
    expect(existsSync(join(w.root, 'docs/adr/0003-move-the-graphql-api-sessions-in-api-public.md'))).toBe(false)
    await spec?.run?.()
    expect(readFileSync(join(w.root, 'docs/adr/0003-move-the-graphql-api-sessions-in-api-public.md'), 'utf8')).toContain('is not in the record: say it here')
    expect(adrOf(w.state).registry.docs.find(doc => doc.number === 3)?.status).toBe('proposed')
  })
})

describe('the page', () => {
  const noAct = new Proxy(() => undefined, { get: (_t, key) => (key === 'then' ? undefined : noAct), apply: () => undefined }) as unknown as Actions
  const draw = (state: State, columns = 110) => viewText({ state, nowMs: Date.now(), columns, act: noAct }, 'adrs')

  it('is in the TOOLS group, has no hotkey, and says it is reading before the folder is read', () => {
    const state = newState({})

    expect(NAV_GROUPS.find(group => group.title === 'TOOLS')?.rows.flat()).toContain('adrs')
    expect(VIEWS.find(view => view.id === 'adrs')).toMatchObject({ key: '', label: 'ADRs' })
    expect(draw(state)).toContain('not read yet')
  })

  it('a project with no ADR folder offers to initialise it, and points at Settings', async () => {
    const w = await world('empty', null)
    const text = draw(w.state)

    expect(text).toContain('no ADR folder found')
    expect(text).toContain('initialise ADRs here')
    expect(text).toContain('Nothing is overwritten')
    expect(text).toContain('Settings')
  })

  it('lists records with status and date, the health strip, the filters and the honest limits', async () => {
    const w = await world('madr')
    const text = draw(w.state)

    expect(text).toContain('docs/decisions')
    expect(text).toContain('madr')
    expect(text).toContain('3 records · 2 accepted · 0 proposed · 1 superseded')
    expect(text).toContain('0003')
    expect(text).toContain('Use Cockroach for storage')
    expect(text).toContain('health: 0 errors')
    expect(text).toContain('compares file PATHS')
    expect(text).toContain('nothing here proves a change follows or breaks a decision')
  })

  it('a selected record shows its links both ways, its decision and the mission it is attached to', async () => {
    const w = await world('nygard')

    await setAttached(w.state, w.host as never, '0003-use-graphql.md', true)
    adrOf(w.state).selected = '0002-use-rest.md'

    const rest = draw(w.state)

    expect(rest).toContain('ADR 2: Use REST for the public API')
    expect(rest).toContain('superseded by')
    expect(rest).toContain('cited by ADRs')

    adrOf(w.state).selected = '0003-use-graphql.md'

    const graph = draw(w.state)

    expect(graph).toContain('supersedes')
    expect(graph).toContain('cited by missions msn_aaaaaaa')
    expect(graph).toContain('Decision: GraphQL')
    expect(graph).toContain('− detach from mission')
  })

  it('draws in both looks and at narrow and wide widths, with hostile titles, without an escape reaching the screen', async () => {
    const w = await world('plain')

    writeFileSync(join(w.root, 'adr/0001-evil.md'), '# 1. Evil\u001b[31m title ‮ <b>x</b>\n\nStatus: Accepted\u001b[2J\n')
    await loadAdrs(w.state, w.host as never)

    for (const look of ['plain', 'bbs'] as const) {
      setLook(look)

      for (const columns of [44, 80, 140]) {
        const text = draw(w.state, columns)

        expect(text, `${look} ${columns}`).toContain('ADR')
        expect(text, `${look} ${columns}`).not.toMatch(/[\u001b‮]/)
      }
    }

    setLook('plain')
  })

  it('every action is a button with a key, pressing reaches the action, and the list pages by j and k', async () => {
    const w = await world('madr')
    const calls: string[] = []
    const recorder = (path: string): unknown => new Proxy(() => undefined, { get: (_t, key) => (key === 'then' ? undefined : recorder(`${path}.${String(key)}`)), apply: (_t, _this, args) => void calls.push(`${path.slice(1)}(${args.join(',')})`) })
    type El = { props: Record<string, unknown> }
    const kit = { Box: (props: Record<string, unknown>): El => ({ props }), Text: (props: Record<string, unknown>): El => ({ props }), Button: (props: Record<string, unknown>): El => ({ props }), Input: (props: Record<string, unknown>): El => ({ props }) }
    const flat = (el: unknown): El[] => {
      const node = el as El

      if (typeof node !== 'object' || node === null) return []

      const kids = node.props?.children

      return [node, ...(Array.isArray(kids) ? kids.flatMap(flat) : typeof kids === 'object' ? flat(kids) : [])]
    }

    adrOf(w.state).selected = '0002-use-postgres.md'

    const tree = adrsView({ kit, state: w.state, nowMs: Date.now(), columns: 120, pictures: new Map(), act: recorder('') as never, cards: true } as never)
    const nodes = flat(tree)
    const by = (key: string) => nodes.find(node => node.props.key === key)

    ;(by('adr-row-0003-use-cockroach.md')?.props.onPress as () => void)()
    ;(by('adr-to-accepted') ?? by('adr-f-accepted'))?.props.onPress
    ;(by('adr-f-accepted')?.props.onPress as () => void)()
    ;(by('adr-reload')?.props.onPress as () => void)()
    ;(by('adr-filter')?.props.onSubmit as (v: string) => void)('cockroach')
    ;(by('adr-propose')?.props.onSubmit as (v: string) => void)('Cache reads')
    ;(by('adr-prev')?.props.onPress as () => void)()

    expect(by('adr-prev')?.props.hotkey).toBe('k')
    expect(by('adr-next')?.props.hotkey).toBe('j')
    expect(calls).toEqual(['adrs.select(0003-use-cockroach.md)', 'adrs.filter([object Object])', 'adrs.reload()', 'adrs.filter([object Object])', 'adrs.propose(Cache reads)', 'adrs.page(0)'])
    // Mouse and keyboard parity: every pressable here is a Button (focusable, Enter and click alike), and the fields are Inputs.
    expect(nodes.filter(node => typeof node.props.onPress === 'function').length).toBeGreaterThan(8)
  })
})

describe('the palette and the control level', () => {
  async function wired() {
    const w = await world('nygard')
    const asked: unknown[] = []
    const actions = adrActions(w.state, w.host as never, { ask: (spec: unknown) => void asked.push(spec) } as never)

    return { ...w, actions, asked }
  }

  it('has an entry for each action, in the palette headless runs use', async () => {
    const w = await wired()
    const ids = adrPalette(w.state).map(entry => entry.id)

    expect(ids).toEqual(['adr-open', 'adr-show', 'adr-init', 'adr-propose', 'adr-accept', 'adr-reject', 'adr-deprecate', 'adr-supersede', 'adr-attach', 'adr-detach', 'adr-scope'])
    expect(paletteEntries(w.state, Date.now()).filter(entry => entry.id.startsWith('adr-')).map(entry => entry.id)).toEqual(ids)
  })

  it('reading is read level; proposing, initialising, changing a status and attaching are write level, never network, spend or delete', async () => {
    const w = await wired()
    const entry = (id: string) => adrPalette(w.state).find(candidate => candidate.id === id)
    const specOf = (id: string, text = '') => {
      const run = entry(id)?.run

      return run?.kind === 'spec' ? run.spec : run?.kind === 'text' ? run.make(text) : null
    }
    const pending = (spec: NonNullable<ReturnType<typeof specOf>>) => ({ label: spec.label, args: spec.args, ...(spec.note !== undefined && { note: spec.note }), ...(spec.shows !== undefined && { shows: spec.shows }), expect: spec.expect, ...(spec.declared !== undefined && { declared: spec.declared }) })
    const classes: Record<string, string> = {}

    for (const [id, text] of [['adr-show', '3'], ['adr-propose', 'Cache reads'], ['adr-accept', '3'], ['adr-reject', '3'], ['adr-deprecate', '3'], ['adr-supersede', '1 3'], ['adr-attach', '3'], ['adr-detach', '3'], ['adr-scope', '']] as const) {
      const spec = specOf(id, text)

      expect(spec, id).not.toBeNull()
      classes[id] = classOf(pending(spec as never))
    }

    expect(Object.fromEntries(Object.entries(classes).filter(([id]) => id !== 'adr-show' && id !== 'adr-scope'))).toEqual({ 'adr-propose': 'write', 'adr-accept': 'write', 'adr-reject': 'write', 'adr-deprecate': 'write', 'adr-supersede': 'write', 'adr-attach': 'write', 'adr-detach': 'write' })
    // Reading goes through the same gate as any entry that declares nothing: it is a read-only spec, which runs at the read level without a pending card.
    expect(specOf('adr-show', '3')?.isReadOnly).toBe(true)
    expect(specOf('adr-show', '3')?.declared).toBeUndefined()
    expect(specOf('adr-scope')?.declared).toBeUndefined()
    expect(entry('adr-open')?.run).toEqual({ kind: 'view', view: 'adrs' })

    for (const id of ['adr-propose', 'adr-accept', 'adr-reject', 'adr-deprecate', 'adr-supersede', 'adr-attach', 'adr-detach']) {
      const spec = specOf(id, id === 'adr-propose' ? 'Cache reads' : id === 'adr-supersede' ? '1 3' : '3')

      expect(spec?.declared, id).toBe('write')
      expect(allows('read', classOf(pending(spec as never))), `${id} at read`).toBe(false)
      expect(allows('write', classOf(pending(spec as never))), `${id} at write`).toBe(true)
    }
  })

  it('a status entry only prepares the change: the diff is a second confirm, and a bad number is no spec', async () => {
    const w = await wired()
    const accept = adrPalette(w.state).find(entry => entry.id === 'adr-deprecate')?.run

    expect(accept?.kind === 'text' && accept.make('999')).toBeNull()
    expect(accept?.kind === 'text' && accept.make('ADR-0003')).not.toBeNull()
    ;(accept?.kind === 'text' ? accept.make('3') : null)?.run?.()
    await new Promise(resolve => setTimeout(resolve, 100))

    const second = w.asked[0] as { shows: string; label: string } | undefined

    expect(second?.label).toBe('mark ADR 3 deprecated')
    expect(second?.shows).toContain('-Accepted')
    expect(second?.shows).toContain('+Deprecated')
  })
})

describe('the settings', () => {
  it('keep a safe folder, a style and a pattern, and refuse an unsafe folder or pattern with a reason', async () => {
    const w = await world('nygard', null)
    const host = w.host as never

    saveAiPrefs(w.state, host, { adrDir: 'notes/decisions', adrStyle: 'madr', adrPattern: 'ADR-{n}-{slug}.md' })
    expect(settingsOf(w.state).ai).toMatchObject({ adrDir: 'notes/decisions', adrStyle: 'madr', adrPattern: 'ADR-{n}-{slug}.md' })
    saveAiPrefs(w.state, host, { adrDir: '../outside' })
    expect(settingsOf(w.state).ai.adrDir).toBe('notes/decisions')
    expect(w.state.outcome?.ok).toBe(false)
    expect(w.state.outcome?.detail).toContain('inside this project')
    saveAiPrefs(w.state, host, { adrPattern: '{n}.md' })
    expect(settingsOf(w.state).ai.adrPattern).toBe('ADR-{n}-{slug}.md')
    expect(w.state.outcome?.detail).toContain('{n} and {slug}')

    const reload = newState({})

    await w.host.storeSet('ai-prefs', { adrDir: '../evil', adrStyle: 'bogus', adrPattern: '../x{n}{slug}.md' })
    await loadAiPrefs(reload, host)
    expect(settingsOf(reload).ai).toMatchObject({ adrDir: '', adrStyle: 'auto', adrPattern: '' })
  })

  it('a named style and pattern shape what a new record is called and looks like', async () => {
    const w = await world('nygard', null)

    settingsOf(w.state).ai.adrStyle = 'ruflo'
    settingsOf(w.state).ai.adrPattern = 'ADR-{n}-{slug}.md'
    await loadAdrs(w.state, w.host as never)
    expect(adrOf(w.state).style).toMatchObject({ name: 'ruflo', pattern: 'ADR-{n}-{slug}.md', source: 'setting' })
    expect(attachedDocs).toBeTypeOf('function')
  })
})

void [mkdtempSync, tmpdir]
