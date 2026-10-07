/**
 * The ADRs page's logic (ADR-480): find the ADR folder of the project the console is running in, read and index its records, write a
 * new one or change a status through the confirm row (with the exact file and diff in view), attach records to a mission, and keep the
 * digest the mission, the loop and the swarm agents read. Every read and write may fail; none throws. Writes stay inside the project
 * root: a folder or file that is a link is never read or written through, a new file never overwrites, and a status change is refused
 * if the file moved since the diff was shown. The pure parts are in data/adr.ts, data/adr-write.ts and data/adr-scope.ts.
 */
import type { ActionSpec } from './actions'
import { replaceFile } from './activity-io'
import { indexOf, lint, MAX_FILE, MAX_FILES, parseAdr, type AdrDoc, type AdrStatus, type Finding, type Registry, STATUSES } from './data/adr'
import { checkScope, digestBlock, reportLines, suggest, type ScopeReport, type Suggestion } from './data/adr-scope'
import { adrDirText, detectStyle, draftFromMission, fileNameFor, initialRecord, lineDiff, nextNumber, renderNew, titleText, withStatus, withSupersedes, type Style, type StyleName } from './data/adr-write'
import { record as recordEvents } from './data/events'
import { readBounded, type ReadCache } from './data/files'
import { plain } from './data/parse'
import { checkNoLinks, dirOf, newFileArgv, replaceFileArgv } from './data/wf-file'
import type { Host } from './host'
import { activeMission, mcOf, record, saveLedger } from './mission-control'
import type { MissionRecord } from './mission-types'
import type { Runner } from './runner'
import { settingsOf } from './settings'
import type { State } from './state'

/** Where projects keep ADRs, in the order they are tried when the person has not named a folder. */
export const ADR_FOLDERS: readonly string[] = ['docs/adr', 'docs/adrs', 'doc/adr', 'doc/adrs', 'adr', 'adrs', 'docs/architecture/decisions', 'docs/architecture/adr', 'docs/decisions', 'architecture/decisions', 'decisions']
/** The folder `initialise` creates when the project has none. */
export const DEFAULT_FOLDER = 'docs/adr'

const INDEX_FILE = /^(?:readme|index|_index|summary)\.md$|^index[-_.].*\.md$/i
const SKIP_FILE = /template/i
const ADR_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.md$/
export const MAX_RESULT_LINES = 40

export type AdrFilter = { status: AdrStatus | 'all'; text: string; scope: string }
export type AdrLast = { label: string; ok: boolean; lines: string[] }

export type AdrState = {
  /** The folder was looked for and read (until then the page says it is reading). */
  isLoaded: boolean
  isLoading: boolean
  /** The folder, relative to the project; null when there is none (or it was refused). */
  dir: string | null
  /** Why there is no folder or what was skipped, in a line. */
  why: string
  registry: Registry
  findings: Finding[]
  files: string[]
  index: string | null
  style: Style
  filter: AdrFilter
  page: number
  selected: string | null
  last: AdrLast | null
  scope: ScopeReport | null
  loadedAtMs: number
  cache: ReadCache
}

const empty = (): Registry => indexOf([])
const states = new WeakMap<State, AdrState>()

export function adrOf(state: State): AdrState {
  let found = states.get(state)

  if (found === undefined) {
    found = { isLoaded: false, isLoading: false, dir: null, why: 'not read yet', registry: empty(), findings: [], files: [], index: null, style: detectStyle([]), filter: { status: 'all', text: '', scope: '' }, page: 0, selected: null, last: null, scope: null, loadedAtMs: 0, cache: new Map() }
    states.set(state, found)
  }

  return found
}

const root = (state: State): string => state.cwd.replace(/\/+$/, '')
const isDir = (kind: string | undefined): boolean => kind === 'dir' || kind === 'directory'

/** The folder the project keeps its ADRs in: the setting if there is one, else the first usual place that exists. A link is refused. */
export async function discover(host: Pick<Host, 'fs'>, cwd: string, setting: string): Promise<{ dir: string | null; why: string }> {
  const base = cwd.replace(/\/+$/, '')
  const named = adrDirText(setting)
  const tries = named !== null && named !== '' ? [named] : ADR_FOLDERS
  let refused = ''

  if (base === '' || !base.startsWith('/')) return { dir: null, why: 'no project folder is known' }

  for (const candidate of tries) {
    const stat = await host.fs.stat(`${base}/${candidate}`).catch(() => undefined)

    if (stat === undefined) continue

    // Every folder on the way down must be a real one: a link could lead out of the project.
    const safe = await checkNoLinks(host.fs, `${base}/${candidate}/.adr-probe`, { cwd: base }, { allowExisting: true })

    if (!safe.ok) {
      refused = refused === '' ? `${candidate}: ${safe.why}` : refused
      continue
    }
    if (!isDir(stat.kind)) {
      refused = refused === '' ? `${candidate} is not a folder` : refused
      continue
    }

    return { dir: candidate, why: '' }
  }

  return { dir: null, why: refused !== '' ? `not read: ${refused}` : named !== null && named !== '' ? `no folder ${named} in this project` : `no ADR folder found (looked for ${ADR_FOLDERS.slice(0, 5).join(', ')} and ${ADR_FOLDERS.length - 5} more)` }
}

/** Reads the folder again: finds it, parses every record (bounded), lints, detects the style. Never throws. */
export async function loadAdrs(state: State, host: Pick<Host, 'fs' | 'invalidate'>): Promise<void> {
  const adr = adrOf(state)

  if (adr.isLoading) return

  adr.isLoading = true
  host.invalidate()

  try {
    const prefs = settingsOf(state).ai
    const found = await discover(host, state.cwd, prefs.adrDir)

    if (found.dir === null) {
      adr.dir = null
      adr.why = found.why
      adr.registry = empty()
      adr.findings = []
      adr.files = []
      adr.index = null
    } else {
      const entries = await host.fs.list(`${root(state)}/${found.dir}`).catch(() => [])
      const names = entries.filter(entry => entry.kind !== 'symlink' && entry.kind !== 'link' && !isDir(entry.kind) && ADR_NAME.test(entry.name)).map(entry => entry.name).sort()
      const indexName = names.find(name => INDEX_FILE.test(name)) ?? null
      const candidates = names.filter(name => !INDEX_FILE.test(name) && !SKIP_FILE.test(name))
      const kept = candidates.slice(0, MAX_FILES)
      const docs: AdrDoc[] = []
      let skipped = 0

      for (let i = 0; i < kept.length; i += 16) {
        const reads = await Promise.all(kept.slice(i, i + 16).map(async name => ({ name, read: await readBounded(host.fs, adr.cache, `${root(state)}/${found.dir}/${name}`, MAX_FILE * 4, true).catch(() => null) })))

        for (const { name, read } of reads) {
          if (read === null || read.text === null) skipped += 1
          else docs.push(parseAdr(name, read.text))
        }
      }

      const indexRead = indexName === null ? null : await readBounded(host.fs, adr.cache, `${root(state)}/${found.dir}/${indexName}`, 400_000, true).catch(() => null)

      adr.dir = found.dir
      adr.why = skipped > 0 ? `${skipped} file${skipped === 1 ? '' : 's'} could not be read (a link, too large, or refused)` : ''
      adr.registry = indexOf(docs, candidates.length > MAX_FILES)
      adr.files = names
      adr.index = indexRead?.text ?? null
      adr.findings = lint(adr.registry, names, adr.index)
    }

    adr.style = detectStyle(adr.registry.docs, { style: prefs.adrStyle, pattern: prefs.adrPattern })
    adr.isLoaded = true
    adr.loadedAtMs = Date.now()
    if (adr.selected !== null && !adr.registry.docs.some(doc => doc.file === adr.selected)) adr.selected = null
  } catch {
    adr.why = 'the ADR folder could not be read'
  } finally {
    adr.isLoading = false
    host.invalidate()
  }
}

export const docOf = (state: State, file: string): AdrDoc | undefined => adrOf(state).registry.docs.find(doc => doc.file === file)
export const docByNumber = (state: State, number: number): AdrDoc | undefined => adrOf(state).registry.byNumber.get(number)?.[0]

const say = (state: State, host: Pick<Host, 'invalidate'>, label: string, ok: boolean, lines: string[]): void => {
  adrOf(state).last = { label, ok, lines: lines.slice(0, MAX_RESULT_LINES).map(line => plain(line, 200)) }
  host.invalidate()
}

/** One event on the Events page and one toast (source console, level info): the ADR said what happened, once. */
function announce(state: State, host: Pick<Host, 'toast'>, text: string): void {
  const line = plain(text, 118)

  recordEvents(state.events, [{ atMs: Date.now(), kind: 'notices', text: `adr: ${line}` }])
  if (state.isInteractive) host.toast(line, 6000, 'info')
}

const abs = (state: State, dir: string, name: string): string => `${root(state)}/${dir}/${name}`

async function writeNew(state: State, host: Pick<Host, 'fs' | 'run'>, dir: string, name: string, text: string): Promise<string | null> {
  const path = abs(state, dir, name)
  const safe = await checkNoLinks(host.fs, path, { cwd: root(state) })

  if (!safe.ok) return safe.why

  const hasDir = (await host.fs.stat(dirOf(path)).catch(() => undefined)) !== undefined
  const result = await host.run(newFileArgv(path, hasDir), 10_000, text).catch(() => null)

  if (result === null || result.exitCode !== 0) return 'the file could not be created (it may have appeared meanwhile: nothing was overwritten)'

  const back = await host.fs.read(path).catch(() => null)

  return back === text ? null : 'the file was written but reads back differently'
}

/** The new file as the confirm shows it: every line, up to 40, each marked +. */
const preview = (text: string): string => `${text.split('\n').slice(0, 40).map(line => `+${line}`).join('\n')}${text.split('\n').length > 40 ? '\n+… (the rest of the file is the same template)' : ''}`

/** The confirm for creating the project's first record (and its folder). Never overwrites. */
export function initSpec(state: State, host: Pick<Host, 'fs' | 'run' | 'invalidate' | 'toast'>, today: string): ActionSpec | null {
  const adr = adrOf(state)

  if (adr.dir !== null) return null

  const dir = adrDirText(settingsOf(state).ai.adrDir) || DEFAULT_FOLDER
  const style = detectStyle([], { style: settingsOf(state).ai.adrStyle === 'auto' ? 'nygard' : settingsOf(state).ai.adrStyle, pattern: settingsOf(state).ai.adrPattern })
  const first = initialRecord(style, today)

  return {
    label: `initialise ADRs here: create ${dir}/${first.file}`,
    scope: 'adrs',
    args: [],
    declared: 'write',
    shows: `create ${dir}/${first.file} inside this project (a new file; an existing file is never overwritten)\n${preview(first.text)}`,
    expect: `${dir}/${first.file} in this project`,
    note: 'Creates the folder if it is missing and one new file in it. Nothing is overwritten and nothing outside this project is touched.',
    run: async () => {
      const problem = await writeNew(state, host, dir, first.file, first.text)

      await loadAdrs(state, host)
      say(state, host, 'initialise ADRs', problem === null, problem === null ? [`created ${dir}/${first.file}`, 'your project now has an ADR folder; propose the next record from this page'] : [problem])
      if (problem === null) announce(state, host, `ADRs initialised: ${dir}/${first.file}`)
    },
  }
}

/** The confirm for a new proposed record: the next number, the project's file name and headings, never overwriting. */
export function proposeSpec(state: State, host: Pick<Host, 'fs' | 'run' | 'invalidate' | 'toast'>, rawTitle: string, today: string, extra: { context?: string; decision?: string; scope?: string[] } = {}): ActionSpec | null {
  const adr = adrOf(state)
  const title = titleText(rawTitle)

  if (adr.dir === null || title === '') return null

  const dir = adr.dir
  const number = nextNumber(adr.registry.docs)
  const name = fileNameFor(adr.style, number, title)

  if (!ADR_NAME.test(name) || adr.files.includes(name)) return null

  const text = renderNew(adr.style, { number, title, date: today, status: 'proposed', ...(extra.scope !== undefined && { scope: extra.scope }), ...(extra.context !== undefined && { context: extra.context }), ...(extra.decision !== undefined && { decision: extra.decision }) })

  return {
    label: `propose ADR ${number}: ${title}`,
    scope: 'adrs',
    args: [],
    declared: 'write',
    shows: `create ${dir}/${name} (a new file; an existing file is never overwritten)\n${preview(text)}`,
    expect: `${dir}/${name} in this project`,
    note: `Writes one new file in your project's ADR folder, in the style ${adr.style.name} (${adr.style.source}). It is only proposed: nothing binds anyone until it is accepted.`,
    run: async () => {
      const problem = await writeNew(state, host, dir, name, text)

      await loadAdrs(state, host)
      if (problem === null) adrOf(state).selected = name
      say(state, host, `propose ADR ${number}`, problem === null, problem === null ? [`created ${dir}/${name}`, 'edit its Context and Decision, then accept it from this page'] : [problem])
      if (problem === null) announce(state, host, `ADR ${number} proposed: ${title}`)
    },
  }
}

const TRANSITIONS: Record<AdrStatus, AdrStatus[]> = { proposed: ['accepted', 'rejected'], accepted: ['superseded', 'deprecated'], superseded: [], deprecated: ['accepted'], rejected: ['proposed'], unknown: ['proposed', 'accepted'] }
export const transitionsOf = (doc: AdrDoc): AdrStatus[] => TRANSITIONS[doc.status]

type Change = { file: string; before: string; after: string }

/** The files a status change would edit, as before and after: one, or two when an ADR is superseded by another. */
export async function planStatus(state: State, host: Pick<Host, 'fs'>, doc: AdrDoc, to: AdrStatus, by: AdrDoc | null): Promise<{ ok: true; changes: Change[] } | { ok: false; why: string }> {
  const adr = adrOf(state)

  if (adr.dir === null) return { ok: false, why: 'no ADR folder' }
  if (to === doc.status) return { ok: false, why: `it is already ${to}` }
  if (!TRANSITIONS[doc.status].includes(to)) return { ok: false, why: `${doc.status} → ${to} is not a change this page makes (${TRANSITIONS[doc.status].join(', ') || 'none'} follow ${doc.status})` }
  if (to === 'superseded' && (by === null || by.number === null || by === doc || by.status === 'rejected')) return { ok: false, why: 'superseding needs another record (accepted or proposed) that replaces this one' }

  const read = async (file: string): Promise<string | null> => (await readBounded(host.fs, new Map(), abs(state, adr.dir as string, file), MAX_FILE * 4, true).catch(() => null))?.text ?? null
  const before = await read(doc.file)

  if (before === null) return { ok: false, why: `${doc.file} could not be read` }

  const byRef = by === null || by.number === null ? null : { number: by.number, title: by.title, file: by.file }
  const edited = withStatus(before, doc, adr.style, to, byRef)

  if (!edited.ok) return { ok: false, why: edited.why }

  const changes: Change[] = [{ file: doc.file, before, after: edited.text }]

  if (to === 'superseded' && by !== null && doc.number !== null) {
    const newer = await read(by.file)

    if (newer === null) return { ok: false, why: `${by.file} could not be read` }

    const linked = withSupersedes(newer, by, adr.style, { number: doc.number, title: doc.title, file: doc.file })

    if (!linked.ok) return { ok: false, why: linked.why }
    if (linked.text !== newer) changes.push({ file: by.file, before: newer, after: linked.text })
  }

  return { ok: true, changes }
}

/** The confirm for a status change: the exact files and the diff of each. At run time each file is read again and must be unchanged. */
export async function statusSpec(state: State, host: Pick<Host, 'fs' | 'run' | 'invalidate' | 'toast'>, doc: AdrDoc, to: AdrStatus, by: AdrDoc | null = null): Promise<ActionSpec | null> {
  const adr = adrOf(state)
  const plan = await planStatus(state, host, doc, to, by)

  if (!plan.ok) {
    say(state, host, `change ADR ${doc.number ?? doc.file}`, false, [plan.why])

    return null
  }

  const dir = adr.dir as string
  const word = to === 'superseded' && by !== null ? `superseded by ADR ${by.number}` : to

  return {
    label: `mark ADR ${doc.number ?? doc.file} ${word}`,
    scope: 'adrs',
    args: [],
    declared: 'write',
    shows: plan.changes.map(change => `${dir}/${change.file}\n${lineDiff(change.before, change.after, change.file).join('\n')}`).join('\n\n'),
    expect: plan.changes.map(change => `${dir}/${change.file}`).join(' and '),
    note: `Changes only the lines shown, in ${plan.changes.length} file${plan.changes.length === 1 ? '' : 's'} of your project. A file that changed since this diff was made is left alone.`,
    run: async () => {
      const done: string[] = []

      for (const change of plan.changes) {
        const path = abs(state, dir, change.file)
        const safe = await checkNoLinks(host.fs, path, { cwd: root(state) }, { allowExisting: true })

        if (!safe.ok) return say(state, host, `change ADR ${doc.number ?? doc.file}`, false, [...done, safe.why])

        const now = await host.fs.read(path).catch(() => null)

        if (now !== change.before) return say(state, host, `change ADR ${doc.number ?? doc.file}`, false, [...done, `${change.file} changed since the diff was shown: nothing was written to it. Ask again.`])

        const result = await host.run(replaceFileArgv(path, true), 10_000, change.after).catch(() => null)
        const back = await host.fs.read(path).catch(() => null)

        if (result === null || result.exitCode !== 0 || back !== change.after) return say(state, host, `change ADR ${doc.number ?? doc.file}`, false, [...done, `${change.file} could not be written as shown`])

        done.push(`wrote ${change.file}`)
      }

      await loadAdrs(state, host)
      say(state, host, `change ADR ${doc.number ?? doc.file}`, true, done)
      announce(state, host, `ADR ${doc.number ?? doc.file} ${to === 'superseded' && by !== null ? `superseded by ADR ${by.number}` : to}`)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------- missions

export const MAX_ATTACH = 8
const FILE_SAFE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.md$/

/** The file names a mission has attached, validated (a saved ledger is not trusted). */
export const attachedOf = (mission: MissionRecord): string[] => (Array.isArray(mission.adrs) ? mission.adrs.filter((file): file is string => typeof file === 'string' && FILE_SAFE.test(file)).slice(0, MAX_ATTACH) : [])

/** The attached records that are in this project's folder now (an attached file that was removed simply is not listed). */
export const attachedDocs = (state: State, mission: MissionRecord): AdrDoc[] => attachedOf(mission).flatMap(file => docOf(state, file) ?? [])

/** What Claude and the swarm agents read for a mission: the digest block, or '' with no ADR attached. */
export const adrBlockFor = (state: State, mission: MissionRecord | null): string => (mission === null ? '' : digestBlock(attachedDocs(state, mission)))

export function suggestFor(state: State, mission: MissionRecord | null, goal: string): Suggestion[] {
  return suggest(goal, adrOf(state).registry.docs, mission === null ? [] : attachedOf(mission))
}

export async function setAttached(state: State, host: Host, file: string, on: boolean): Promise<void> {
  const mission = activeMission(state)

  if (mission === null) return say(state, host, 'attach ADR', false, ['no active mission: create one in Missions first'])
  if (!FILE_SAFE.test(file) || docOf(state, file) === undefined) return say(state, host, 'attach ADR', false, [`${plain(file, 60)} is not an ADR in this project`])

  const now = attachedOf(mission)

  if (on && !now.includes(file) && now.length >= MAX_ATTACH) return say(state, host, 'attach ADR', false, [`a mission carries at most ${MAX_ATTACH} ADRs`])

  mission.adrs = on ? [...new Set([...now, file])] : now.filter(each => each !== file)
  record(mission, { type: on ? 'adr.attached' : 'adr.detached', note: plain(file, 120) })
  saveLedger(state, host)
  await mirrorDigest(state, host)
  say(state, host, on ? 'attach ADR' : 'detach ADR', true, [`${file} ${on ? 'attached to' : 'detached from'} the mission`])
  announce(state, host, `ADR ${docOf(state, file)?.number ?? file} ${on ? 'attached to' : 'detached from'} the mission`)
}

/** Where the swarm plugin reads the digest: a small, masked file under the console's own folder. */
export const DIGEST_FILE = '.claude-flow/console/adr-digest.json'

/**
 * Writes (or clears) the digest the swarm plugin appends to a spawned subagent's prompt. Only the active mission's attached ADRs; the
 * text is the same masked, capped block Claude reads. Never throws.
 */
export async function mirrorDigest(state: State, host: Pick<Host, 'fs' | 'run'>): Promise<string | null> {
  const mission = activeMission(state)
  const docs = mission === null ? [] : attachedDocs(state, mission)
  const body = JSON.stringify({ v: 1, atMs: Date.now(), mission: mission?.id ?? '', adrs: docs.slice(0, MAX_ATTACH).map(doc => ({ number: doc.number, file: doc.file, status: doc.status })), block: digestBlock(docs) })

  return replaceFile(host, state.cwd, `${root(state)}/${DIGEST_FILE}`, body)
}

/** Files changed in the project: uncommitted work, and commits since the mission began. Read-only git. */
export async function changedFiles(host: Pick<Host, 'run'>, cwd: string, sinceMs: number): Promise<string[]> {
  const out = new Set<string>()
  const status = await host.run(['git', '-C', cwd, 'status', '--porcelain'], 15_000).catch(() => null)

  for (const line of (status?.stdout ?? '').split('\n')) {
    const path = line.slice(3).split(' -> ').pop()?.trim().replace(/^"|"$/g, '')

    if (path !== undefined && path !== '') out.add(path)
  }

  const log = await host.run(['git', '-C', cwd, 'log', `--since=${new Date(Math.max(0, sinceMs)).toISOString()}`, '--name-only', '--pretty=format:'], 15_000).catch(() => null)

  for (const line of (log?.stdout ?? '').split('\n')) if (line.trim() !== '') out.add(line.trim())

  return [...out].slice(0, 400)
}

/** The scope check for the active mission: a warning per accepted ADR whose paths a changed file falls under. Recorded as mission evidence; blocks nothing. */
export async function scopeCheck(state: State, host: Pick<Host, 'run' | 'invalidate'>): Promise<string[]> {
  const mission = activeMission(state)

  if (mission === null) return ['no active mission']

  const docs = attachedDocs(state, mission)
  const report = checkScope(docs.length === 0 ? [] : await changedFiles(host, state.cwd, mission.createdAtMs), docs)
  const lines = reportLines(report)

  adrOf(state).scope = report
  if (docs.length > 0) record(mission, { type: 'adr.scope', note: plain(lines.join(' | '), 400) })
  host.invalidate()

  return lines
}

/** A draft record for the active mission, as a proposeSpec: only the mission's own words; a person writes the decision. */
export function draftSpec(state: State, host: Pick<Host, 'fs' | 'run' | 'invalidate' | 'toast'>, today: string): ActionSpec | null {
  const mission = activeMission(state)

  if (mission === null) return null

  const finished = mission.events.filter(event => event.type === 'task.complete' || event.status === 'done')
  const results = new Map<string, string>(finished.flatMap(event => (event.taskId !== undefined && event.note !== undefined ? [[event.taskId, event.note] as [string, string]] : [])))
  const draft = draftFromMission({ objective: mission.objective, tasks: mission.tasks.map(task => ({ title: task.title, ...(results.has(task.id) && { result: results.get(task.id) as string }) })) }, attachedDocs(state, mission).flatMap(doc => doc.scope.slice(0, 2)), today)

  return proposeSpec(state, host, draft.title, today, { ...(draft.context !== undefined && { context: draft.context }), ...(draft.decision !== undefined && { decision: draft.decision }), scope: draft.scope ?? [] })
}

export type AdrActions = {
  reload: () => void
  filter: (patch: Partial<AdrFilter>) => void
  select: (file: string | null) => void
  page: (to: number) => void
  init: () => void
  propose: (title: string) => void
  status: (file: string, to: AdrStatus) => void
  supersede: (file: string, byNumber: string) => void
  attach: (file: string, on: boolean) => void
  scope: () => void
  draft: () => void
}

export type AdrWired = { host: Host; actions: AdrActions }
const wired = new WeakMap<State, AdrWired>()
export const adrWired = (state: State): AdrWired | undefined => wired.get(state)

const today = (): string => new Date().toISOString().slice(0, 10)

export function adrActions(state: State, host: Host, runner: Runner): AdrActions {
  const adr = adrOf(state)
  const reason = 'open the ADRs page to read the project’s ADR folder first'
  const ask = (spec: ActionSpec | null, why: string) => runner.ask(spec, why)
  const actions: AdrActions = {
    reload: () => void loadAdrs(state, host),
    filter: patch => {
      adr.page = 0
      adr.filter = { ...adr.filter, ...patch, status: patch.status !== undefined && (patch.status === 'all' || STATUSES.includes(patch.status as (typeof STATUSES)[number])) ? patch.status : adr.filter.status }
      host.invalidate()
    },
    page: to => {
      adr.page = Math.max(0, Math.floor(to))
      host.invalidate()
    },
    select: file => {
      adr.selected = file
      host.invalidate()
    },
    init: () => ask(initSpec(state, host, today()), adr.dir === null ? 'cannot initialise' : 'this project already has an ADR folder'),
    propose: title => ask(proposeSpec(state, host, title, today()), adr.dir === null ? reason : 'type a title for the record'),
    status: (file, to) => {
      const doc = docOf(state, file)

      if (doc === undefined) return say(state, host, 'change ADR', false, [`${plain(file, 60)} is not an ADR here`])

      void statusSpec(state, host, doc, to).then(spec => (spec === null ? undefined : ask(spec, 'nothing to change')))
    },
    supersede: (file, byNumber) => {
      const doc = docOf(state, file)
      const by = /^\d{1,6}$/.test(byNumber.trim()) ? docByNumber(state, Number(byNumber.trim())) : undefined

      if (doc === undefined || by === undefined) return say(state, host, 'supersede ADR', false, ['give the number of the record that replaces this one'])

      void statusSpec(state, host, doc, 'superseded', by).then(spec => (spec === null ? undefined : ask(spec, 'nothing to change')))
    },
    attach: (file, on) => void setAttached(state, host, file, on),
    scope: () => void scopeCheck(state, host).then(lines => say(state, host, 'ADR scope check', true, lines)),
    draft: () => ask(draftSpec(state, host, today()), 'no active mission to draft from, or no ADR folder yet'),
  }

  wired.set(state, { host, actions })

  return actions
}
