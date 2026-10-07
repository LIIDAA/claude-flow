/**
 * The ADR registry (ADR-480): the parser and lint over the conventions real projects use, the style detection and the writes, the mission
 * digest and the scope matcher, with hostile files and a mutation check on the three pure modules. The fixture projects are in
 * tests/fixtures/adr-projects (MADR, Nygard / adr-tools, ruflo style, log4brains, plain, mixed, empty); ruflo's own ADRs are one more set.
 * Run with
 *   npx vitest run plugins/ruflo-console/tests/adr.spec.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { filterDocs, graphOf, indexOf, lint, MAX_FILE, parseAdr, type AdrDoc } from '../hooks/data/adr'
import { checkScope, digestBlock, reportLines, scopeHits, suggest } from '../hooks/data/adr-scope'
import { adrDirText, detectStyle, draftFromMission, fileNameFor, initialRecord, lineDiff, nextNumber, patternOf, renderNew, slugOf, withStatus, withSupersedes } from '../hooks/data/adr-write'
import { adrOf, discover, loadAdrs, statusSpec, planStatus, initSpec, proposeSpec } from '../hooks/adr'
import { newState, type State } from '../hooks/state'
import { fsOfRoot, hostOfRoot, tempProject } from './adr-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'adr-projects')
const RUFLO_ADRS = join(HERE, '..', '..', '..', 'v3', 'docs', 'adr')
const TODAY = '2026-10-07'

const cleanups: string[] = []

afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

const project = (name: string): string => {
  const dir = tempProject(FIXTURES, name)

  cleanups.push(dir)

  return dir
}

const stateAt = (root: string): State => {
  const state = newState({})

  state.cwd = root
  state.isInteractive = true

  return state
}

const loaded = async (name: string) => {
  const root = project(name)
  const state = stateAt(root)
  const world = hostOfRoot(root)

  await loadAdrs(state, world.host as never)

  return { root, state, world }
}

const docsOf = (name: string, folder: string): AdrDoc[] => readdirSync(join(FIXTURES, name, folder)).filter(f => f.endsWith('.md') && !/^readme/i.test(f)).sort().map(f => parseAdr(f, readFileSync(join(FIXTURES, name, folder, f), 'utf8')))

describe('the conventions of real projects', () => {
  it('reads MADR front matter: status, date, a superseded-by status and a supersedes field', () => {
    const [one, two, three] = docsOf('madr', 'docs/decisions') as [AdrDoc, AdrDoc, AdrDoc]

    expect([one.format, one.status, one.date, one.number, one.title]).toEqual(['madr', 'accepted', '2024-03-02', 1, 'Use Markdown Architectural Decision Records'])
    expect([two.status, two.supersededBy, two.date]).toEqual(['superseded', [3], '2024-03-10'])
    expect([three.status, three.supersedes]).toEqual(['accepted', [2]])
    expect(one.refs).toEqual([12])
    expect(three.refs).toEqual([77])
    expect(two.scope).toEqual(expect.arrayContaining(['src/db/', 'services/orders/store.ts']))
    expect(one.decision).toContain('MADR 3.0')
  })

  it('reads Nygard / adr-tools: the Status section, Superseded by and Supersedes links, Date: lines, "1." titles', () => {
    const [one, two, three] = docsOf('nygard', 'doc/adr') as [AdrDoc, AdrDoc, AdrDoc]

    expect([one.format, one.status, one.date, one.title]).toEqual(['nygard', 'accepted', '2018-02-12', 'Record architecture decisions'])
    expect([two.status, two.supersededBy]).toEqual(['superseded', [3]])
    expect([three.status, three.supersedes]).toEqual(['accepted', [2]])
    expect(three.decision).toContain('GraphQL')
    expect(two.scope).toContain('api/public')
  })

  it('reads the ruflo style: bold and plain Status/Date lines, a parenthesis after the status, Scope and Builds on', () => {
    const [one, two] = docsOf('ruflo-style', 'docs/adrs') as [AdrDoc, AdrDoc]

    expect([one.format, one.status, one.statusRaw, one.date, one.number]).toEqual(['inline', 'accepted', 'Accepted — Implemented in 1.2.0', '2025-01-10', 1])
    expect(one.scope).toEqual(expect.arrayContaining(['services/bus/', 'libs/events/index.ts']))
    expect(one.relates).toEqual([2])
    expect(one.refs).toEqual([41])
    expect([two.status, two.date, two.relates, two.scope]).toEqual(['proposed', '2025-02-01', [1], ['libs/events/retry.ts']])
  })

  it('reads log4brains (a date-prefixed name is not a sequence number) and plain markdown with no status at all', () => {
    const [log] = docsOf('log4brains', 'docs/adr') as [AdrDoc]
    const [plain] = docsOf('plain', 'adr') as [AdrDoc]

    expect([log.status, log.date, log.format, log.number, log.title]).toEqual(['accepted', '2020-01-01', 'inline', null, 'Use Log4brains to manage the ADRs'])
    expect([plain.status, plain.statusRaw, plain.format, plain.notes]).toEqual(['unknown', '', 'bare', ['no status', 'no number in the file name or title']])
    expect(plain.scope).toEqual(['src/auth/'])
  })

  it('reads the variants of ruflo’s own table-form, bullet-form and list-item status lines', () => {
    const table = parseAdr('ADR-376-x.md', '# ADR-376: X\n\n| Field | Value |\n|---|---|\n| Status | Proposed |\n| Date | 2026-07-27 |\n')
    const bullet = parseAdr('ADR-104-x.md', '# ADR-104 — X\n\n- Status: **Accepted — Implemented; pending v2**\n- Date: 2026-05-09\n- Supersedes / extends: [ADR-097 — Y](./ADR-097-y.md)\n')
    const list = parseAdr('ADR-322A-x.md', '# ADR-322A: X\n\n- **Status**: Accepted — implemented\n- **Parent**: ADR-322\n')
    const spaced = parseAdr('ADR-430-x.md', '# ADR 430: X\n\nStatus: Accepted (ships in ruflo-console 0.26.0)\n\nDate: 2026 10 03\n')

    expect([table.status, table.date]).toEqual(['proposed', '2026-07-27'])
    expect([bullet.status, bullet.date, bullet.supersedes]).toEqual(['accepted', '2026-05-09', [97]])
    expect([list.status, list.number, list.variant, list.relates]).toEqual(['accepted', 322, 'A', [322].filter(() => false)])
    expect([spaced.status, spaced.date, spaced.number]).toEqual(['accepted', '2026-10-03', 430])
  })

  it('parses every one of ruflo’s own ADRs with a number, a title and, nearly always, a status, date, scope and decision', () => {
    const files = readdirSync(RUFLO_ADRS).filter(f => /^ADR-.*\.md$/.test(f))
    const docs = files.map(f => parseAdr(f, readFileSync(join(RUFLO_ADRS, f), 'utf8')))
    const count = (test: (doc: AdrDoc) => boolean) => docs.filter(test).length

    expect(docs.length).toBeGreaterThanOrEqual(250)
    expect(count(doc => doc.number !== null)).toBe(docs.length)
    expect(count(doc => doc.title.length > 3)).toBe(docs.length)
    expect(count(doc => doc.statusRaw !== '')).toBeGreaterThan(docs.length * 0.97)
    expect(count(doc => doc.status === 'accepted')).toBeGreaterThan(100)
    expect(count(doc => doc.status === 'proposed')).toBeGreaterThan(60)
    expect(count(doc => doc.date !== null)).toBeGreaterThan(docs.length * 0.97)
    expect(count(doc => doc.scope.length > 0)).toBeGreaterThan(docs.length * 0.8)
    expect(count(doc => doc.decision !== '')).toBeGreaterThan(docs.length * 0.85)
    expect(count(doc => doc.relates.length + doc.supersedes.length > 0)).toBeGreaterThan(150)

    const last = docs.find(doc => doc.file.startsWith('ADR-479')) as AdrDoc

    expect([last.status, last.date, last.relates]).toEqual(['accepted', '2026-10-07', [12, 476]])
    expect(last.refs).toEqual(expect.arrayContaining([3598]))
  })

  it('lints ruflo’s own ADRs: the known duplicate numbers are errors, A/B/C siblings are not, and the index is read', () => {
    const names = readdirSync(RUFLO_ADRS).filter(f => f.endsWith('.md'))
    const docs = names.filter(f => /^ADR-/.test(f)).map(f => parseAdr(f, readFileSync(join(RUFLO_ADRS, f), 'utf8')))
    const findings = lint(indexOf(docs), names, readFileSync(join(RUFLO_ADRS, 'INDEX-mod-system.md'), 'utf8'))
    const dupes = new Set(findings.filter(f => f.code === 'duplicate-number').map(f => /^ADR-(\d+)/.exec(f.file)?.[1]))

    expect(dupes.has('430')).toBe(true)
    expect(dupes.has('322')).toBe(false)
    expect(findings.some(f => f.code === 'not-in-index')).toBe(true)
    expect(findings.filter(f => f.code === 'broken-link').length).toBeGreaterThan(0)
  })
})

describe('lint over the fixture projects', () => {
  it('the mixed project: duplicate number, dangling supersedes, no status, no date, a missing and an unlisted record', () => {
    const docs = docsOf('mixed', 'docs/architecture/decisions')
    const names = readdirSync(join(FIXTURES, 'mixed', 'docs/architecture/decisions'))
    const findings = lint(indexOf(docs), names, readFileSync(join(FIXTURES, 'mixed', 'docs/architecture/decisions', 'README.md'), 'utf8'))
    const codes = (code: string) => findings.filter(f => f.code === code).map(f => f.file)

    expect(codes('duplicate-number').sort()).toEqual(['0002-duplicate.md', '0002-madr-one.md'])
    expect(codes('dangling-supersedes')).toEqual(['0002-madr-one.md'])
    expect(codes('no-status')).toEqual(['0004-no-status.md'])
    expect(codes('not-in-index').sort()).toEqual(['0002-duplicate.md', '0002-madr-one.md'])
    expect(codes('status-without-date')).toEqual([])
    expect(findings.filter(f => f.level === 'error')).toHaveLength(2)
  })

  it('a clean project has no findings; a one-sided supersede and a cycle are reported', () => {
    const clean = docsOf('nygard', 'doc/adr')

    expect(lint(indexOf(clean), clean.map(d => d.file))).toEqual([])

    const a = parseAdr('0001-a.md', '# 1. A\n\nDate: 2020-01-01\n\n## Status\n\nAccepted\n\nSupersedes 2\n')
    const b = parseAdr('0002-b.md', '# 2. B\n\nDate: 2020-01-01\n\n## Status\n\nAccepted\n\nSupersedes 1\n')
    const codes = lint(indexOf([a, b]), [a.file, b.file]).map(f => f.code)

    expect(codes).toContain('supersede-cycle')
    expect(codes).toContain('supersede-mismatch')
  })

  it('both directions of every link, and who cites a record', () => {
    const docs = docsOf('nygard', 'doc/adr')
    const registry = indexOf(docs)
    const two = docs[1] as AdrDoc
    const graph = graphOf(registry, two)

    expect(graph.supersededBy.map(d => d.number)).toEqual([3])
    expect(graph.citedBy.map(d => d.number)).toEqual([3])
    expect(graphOf(registry, docs[2] as AdrDoc).supersedes.map(d => d.number)).toEqual([2])
  })

  it('filters by status, words and scope', () => {
    const docs = docsOf('madr', 'docs/decisions')

    expect(filterDocs(docs, { status: 'accepted', text: '', scope: '' }).map(d => d.number)).toEqual([1, 3])
    expect(filterDocs(docs, { status: 'all', text: 'postgres', scope: '' }).map(d => d.number)).toEqual([2])
    expect(filterDocs(docs, { status: 'all', text: '', scope: 'services/orders' }).map(d => d.number)).toEqual([2, 3])
  })
})

describe('hostile files', () => {
  it('a huge file is read to its cap and says so; a long line and nested noise parse fast', () => {
    const huge = parseAdr('0001-huge.md', `# 1. Huge\n\n## Status\n\nAccepted\n\n${'lorem ipsum '.repeat(1_000_000)}`)
    const line = parseAdr('0002-line.md', `# 2. Line\n\n${'a'.repeat(2_000_000)}\n${'* '.repeat(200_000)}\n${'`/'.repeat(100_000)}`)
    const started = Date.now()
    const noise = parseAdr('0003-noise.md', '[]('.repeat(100_000) + '\n' + '#1 '.repeat(100_000))

    expect(huge.notes.join(' ')).toContain(`longer than ${MAX_FILE}`)
    expect(huge.status).toBe('accepted')
    expect(line.title).toBe('Line')
    expect(noise.refs.length).toBeLessThanOrEqual(20)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('escapes, control characters and bidi marks never reach a title, a status or a decision', () => {
    const esc = '\u001b'
    const doc = parseAdr('0005-x.md', `# 5. Title${esc}[31m red${esc}]0;evil\u0007 ‮evil\u0000\n\nStatus: Accepted${esc}[2J​\n\n## Decision\n\nDo \u0001the \u007fthing\n`)

    expect(doc.title).toBe('Title red evil')
    expect(doc.status).toBe('accepted')
    expect(`${doc.title}${doc.statusRaw}${doc.decision}`).not.toMatch(/[\u0000-\u0008\u001b\u007f-\u009f​-‏‪-‮]/)
    expect(doc.decision).toBe('Do the thing')
  })

  it('unterminated front matter, a missing title, binary garbage and an empty file are documents, never errors', () => {
    const cases = ['---\nstatus: accepted\n# no end', '', '\u0000\u0001\u0002'.repeat(1000), '---\n---\n', '#', '## Status\n', 'Status:']

    for (const text of cases) expect(() => parseAdr('0001-x.md', text)).not.toThrow()
    expect(parseAdr('0007-empty.md', '').title).toBe('empty')
    expect(parseAdr('0007-empty.md', '').status).toBe('unknown')
  })

  it('cyclic supersedes and duplicate numbers are findings, and the lint stays bounded', () => {
    const docs = Array.from({ length: 300 }, (_v, i) => parseAdr(`${String((i % 150) + 1).padStart(4, '0')}-n${i}.md`, `# ${i}. N\n\nStatus: Accepted\nDate: 2020-01-01\nSupersedes: ${((i + 1) % 150) + 1}\n`))
    const started = Date.now()
    const findings = lint(indexOf(docs), docs.map(d => d.file))

    expect(findings.some(f => f.code === 'supersede-cycle')).toBe(true)
    expect(findings.some(f => f.code === 'duplicate-number')).toBe(true)
    expect(findings.length).toBeLessThanOrEqual(400)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('markup in a record stays plain text: nothing is rendered or executed', () => {
    const doc = parseAdr('0001-x.md', '# 1. <script>alert(1)</script> [x](javascript:alert(1))\n\nStatus: Accepted\n')

    expect(doc.title).toContain('<script>')
    expect(doc.fileLinks).toEqual([])
  })
})

describe('style, numbering and the records written', () => {
  it('detects the style of each project and falls back to Nygard with four digits', () => {
    expect(detectStyle(docsOf('madr', 'docs/decisions'))).toMatchObject({ name: 'madr', width: 4, pattern: '{n}-{slug}.md', source: 'detected' })
    expect(detectStyle(docsOf('nygard', 'doc/adr'))).toMatchObject({ name: 'nygard', width: 4 })
    expect(detectStyle(docsOf('ruflo-style', 'docs/adrs'))).toMatchObject({ name: 'ruflo', width: 3, pattern: 'ADR-{n}-{slug}.md' })
    expect(detectStyle([])).toMatchObject({ name: 'nygard', width: 4, pattern: '{n}-{slug}.md', source: 'default' })
    expect(detectStyle(docsOf('madr', 'docs/decisions'), { style: 'ruflo', pattern: 'ADR-{n}-{slug}.md' })).toMatchObject({ name: 'ruflo', pattern: 'ADR-{n}-{slug}.md', source: 'setting' })
  })

  it('takes only a safe folder and a safe pattern from a setting', () => {
    for (const bad of ['../x', '/etc', 'a/../b', 'a\\b', 'a b', 'x'.repeat(200), './', 'a/./b']) if (bad !== './') expect(adrDirText(bad), bad).toBeNull()
    expect(adrDirText(' docs/adr/ ')).toBe('docs/adr')
    expect(adrDirText('')).toBe('')
    expect(patternOf('{n}-{slug}.md')).toBe('{n}-{slug}.md')

    for (const bad of ['{n}.md', '{slug}.md', '{n}-{slug}.txt', '../{n}-{slug}.md', '{n}/{slug}.md', '{n}-{slug}\n.md']) expect(patternOf(bad), bad).toBeNull()
  })

  it('allocates the next number above the highest, slugs titles and names files by the pattern', () => {
    expect(nextNumber(docsOf('madr', 'docs/decisions'))).toBe(4)
    expect(nextNumber([])).toBe(1)
    expect(nextNumber(docsOf('mixed', 'docs/architecture/decisions'))).toBe(5)
    expect(slugOf('Use Postgres — for storage!')).toBe('use-postgres-for-storage')
    expect(slugOf('///')).toBe('untitled')
    expect(fileNameFor(detectStyle(docsOf('ruflo-style', 'docs/adrs')), 3, 'Event ordering')).toBe('ADR-003-event-ordering.md')
  })

  it('a new record parses back as proposed, with its number, title, date and scope, in every style', () => {
    for (const name of ['madr', 'nygard', 'ruflo'] as const) {
      const style = { ...detectStyle([]), name }
      const text = renderNew(style, { number: 7, title: 'Cache `reads`', date: TODAY, scope: ['src/cache/', 'bad path'] })
      const doc = parseAdr(fileNameFor(style, 7, 'Cache reads'), text)

      expect([doc.status, doc.date, doc.number, doc.title], name).toEqual(['proposed', TODAY, 7, 'Cache reads'])
      expect(doc.format, name).toBe(name === 'madr' ? 'madr' : name === 'nygard' ? 'nygard' : 'inline')
    }
  })

  it('the first record of a project is Nygard’s own, accepted, and reads back', () => {
    const first = initialRecord(detectStyle([]), TODAY)
    const doc = parseAdr(first.file, first.text)

    expect(first.file).toBe('0001-record-architecture-decisions.md')
    expect([doc.status, doc.number, doc.date, doc.title]).toEqual(['accepted', 1, TODAY, 'Record architecture decisions'])
  })

  it('a status change is the smallest edit its format allows, and the diff shows exactly it', () => {
    const cases: [string, string, string, 'accepted' | 'rejected' | 'deprecated'][] = [
      ['madr', 'docs/decisions', '0001-use-markdown-architectural-decision-records.md', 'deprecated'],
      ['nygard', 'doc/adr', '0003-use-graphql.md', 'deprecated'],
      ['ruflo-style', 'docs/adrs', '0000', 'accepted'],
    ]

    for (const [name, folder, file, to] of cases) {
      const target = file === '0000' ? 'ADR-002-retries.md' : file
      const text = readFileSync(join(FIXTURES, name, folder, target), 'utf8')
      const doc = parseAdr(target, text)
      const edit = withStatus(text, doc, detectStyle(docsOf(name, folder)), to)

      expect(edit.ok).toBe(true)
      if (!edit.ok) continue

      const back = parseAdr(target, edit.text)
      const before = text.split('\n')
      const after = edit.text.split('\n')
      const changed = after.filter((line, i) => line !== before[i])

      expect(back.status, name).toBe(to)
      expect(after.length, name).toBe(before.length)
      expect(changed, name).toHaveLength(1)
      expect(lineDiff(text, edit.text, target).filter(line => /^[-+][^-+]/.test(line) || /^[-+]$/.test(line)), name).toHaveLength(2)
    }
  })

  it('supersede edits the old record’s status and adds the link to the new one; a record with no status gets a status line', () => {
    const style = detectStyle(docsOf('nygard', 'doc/adr'))
    const old = parseAdr('0001-record-architecture-decisions.md', readFileSync(join(FIXTURES, 'nygard', 'doc/adr', '0001-record-architecture-decisions.md'), 'utf8'))
    const text = readFileSync(join(FIXTURES, 'nygard', 'doc/adr', '0001-record-architecture-decisions.md'), 'utf8')
    const newer = parseAdr('0004-x.md', renderNew(style, { number: 4, title: 'X', date: TODAY }))
    const marked = withStatus(text, old, style, 'superseded', { number: 4, title: 'X', file: '0004-x.md' })
    const linked = withSupersedes(renderNew(style, { number: 4, title: 'X', date: TODAY }), newer, style, { number: 1, title: old.title, file: old.file })

    expect(marked.ok && marked.text).toContain('Superseded by [4. X](0004-x.md)')
    expect(linked.ok && parseAdr('0004-x.md', linked.text).supersedes).toEqual([1])
    expect(withStatus(text, old, style, 'superseded', null)).toMatchObject({ ok: false })

    const bare = parseAdr('0009-bare.md', '# 9. Bare\n\nText.\n')
    const set = withStatus('# 9. Bare\n\nText.\n', bare, style, 'accepted')

    expect(set.ok && parseAdr('0009-bare.md', set.text).status).toBe('accepted')
  })

  it('a draft from a mission holds only what the mission said and leaves the decision to a person', () => {
    const draft = draftFromMission({ objective: 'Move sessions to Redis (src/auth/)', tasks: [{ title: 'Add client', result: 'src/auth/redis.ts' }, { title: 'Migrate' }] }, ['src/auth/'], TODAY)

    expect(draft.title).toBe('Move sessions to Redis src/auth/')
    expect(draft.decision).toContain('is not in the record: say it here')
    expect(draft.decision).toContain('- Add client: src/auth/redis.ts')
  })
})

describe('the digest, the suggestion and the scope check', () => {
  const doc = (file: string, status: string, scope: string[], decision = 'Use X.'): AdrDoc => ({ ...parseAdr(file, `# ${Number(file.slice(0, 4))}. Title of ${file}\n\nStatus: ${status}\nDate: 2025-01-01\n\n## Decision\n\n${decision}\n`), scope })

  it('matches a path by exact name, folder, glob and sub-folder-relative name, and not a sibling that shares a prefix', () => {
    expect(scopeHits('src/auth', 'src/auth/login.ts')).toBe(true)
    expect(scopeHits('src/auth/', 'src/auth/login.ts')).toBe(true)
    expect(scopeHits('src/auth/login.ts', 'src/auth/login.ts')).toBe(true)
    expect(scopeHits('src/auth', 'src/authz/login.ts')).toBe(false)
    expect(scopeHits('src/auth', 'src/auth')).toBe(true)
    expect(scopeHits('hooks/nav-state.ts', 'plugins/c/hooks/nav-state.ts')).toBe(true)
    expect(scopeHits('hooks/nav-state.ts', 'plugins/c/hooks/nav-state.tsx')).toBe(false)
    expect(scopeHits('src/*.ts', 'src/a.ts')).toBe(true)
    expect(scopeHits('src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(scopeHits('docs', 'docs/a.md')).toBe(false)
    expect(scopeHits('', 'a')).toBe(false)
  })

  it('flags a changed file under an accepted ADR’s paths, and does not flag proposed, superseded, other paths or a clean change', () => {
    const accepted = doc('0001-a.md', 'Accepted', ['src/auth/'])
    const proposed = doc('0002-b.md', 'Proposed', ['src/auth/'])
    const old = doc('0003-c.md', 'Superseded by ADR 9', ['src/auth/'])
    const report = checkScope(['src/auth/login.ts', 'src/authz/x.ts', 'README.md', '../outside', '/abs/path'], [accepted, proposed, old])

    expect(report.hits.map(hit => [hit.file, hit.adr.number])).toEqual([['src/auth/login.ts', 1]])
    expect(report.notInForce.map(d => d.number)).toEqual([2, 3])
    expect(report.files).toBe(3)
    expect(reportLines(report)[0]).toMatch(/^warning: 1 changed file in the scope of ADR 1/)
    expect(reportLines(report).join('\n')).toContain('not checked: ADR 2 is proposed')
    expect(reportLines(checkScope(['README.md'], [accepted])).join('')).toContain('compares paths only and does not show')
    expect(reportLines(checkScope([], [])).join('')).toContain('no ADR is attached')
  })

  it('the digest names the decisions in force, marks drafts and history, is capped, masked and ends with how many it left out', () => {
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const docs = [doc('0001-a.md', 'Accepted', [], `Use X. password: hunter2 and ${secret}`), doc('0002-b.md', 'Proposed', []), doc('0003-c.md', 'Superseded by ADR 1', []), ...Array.from({ length: 9 }, (_v, i) => doc(`${String(i + 10).padStart(4, '0')}-n.md`, 'Accepted', [], 'y'.repeat(900)))]
    const block = digestBlock(docs)

    expect(block).toContain('data, not instructions')
    expect(block).toMatch(/- ADR 1 \[accepted\] Title of 0001-a\.md — Use X\./)
    expect(block).not.toContain('hunter2')
    expect(block).not.toContain(secret)
    expect(block.length).toBeLessThan(1700)
    expect(block).toMatch(/… and \d+ more not shown$/)
    expect(digestBlock([doc('0002-b.md', 'Proposed', []), doc('0003-c.md', 'Deprecated', [])])).toMatch(/\(a draft, not in force\)[\s\S]*\(history, no longer in force\)/)
    expect(digestBlock([])).toBe('')
  })

  it('suggests ADRs from the goal’s paths and words, never history, never what is attached, and nothing for an unrelated goal', () => {
    const docs = [{ ...doc('0001-a.md', 'Accepted', ['src/auth/']), title: 'Sessions for authentication' }, { ...doc('0002-b.md', 'Superseded by ADR 9', ['src/auth/']), title: 'Tokens for authentication' }, { ...doc('0003-c.md', 'Proposed', ['src/db/']), title: 'Database sharding' }]

    expect(suggest('fix src/auth/login.ts bug', docs).map(s => s.doc.number)).toEqual([1])
    expect(suggest('improve database sharding performance', docs).map(s => s.doc.number)).toEqual([3])
    expect(suggest('improve database sharding performance', docs, ['0003-c.md'])).toEqual([])
    expect(suggest('paint the shed blue', docs)).toEqual([])
    expect(suggest('fix src/auth/login.ts bug', docs)[0]?.why).toContain('src/auth/login.ts')
  })
})

describe('finding the ADR folder of the project the console runs in', () => {
  it.each([
    ['madr', 'docs/decisions', 3],
    ['nygard', 'doc/adr', 3],
    ['ruflo-style', 'docs/adrs', 2],
    ['log4brains', 'docs/adr', 1],
    ['plain', 'adr', 1],
    ['mixed', 'docs/architecture/decisions', 4],
  ])('%s: %s', async (name, folder, count) => {
    const { state } = await loaded(name)

    expect(adrOf(state).dir).toBe(folder)
    expect(adrOf(state).registry.docs).toHaveLength(count)
  })

  it('a project with no ADR folder says so and offers to initialise; a named folder is tried alone', async () => {
    const { state, root } = await loaded('empty')

    expect(adrOf(state).dir).toBeNull()
    expect(adrOf(state).why).toContain('no ADR folder found')
    expect((await discover({ fs: fsOfRoot(root) } as never, root, 'docs/nowhere')).why).toBe('no folder docs/nowhere in this project')
    expect((await discover({ fs: fsOfRoot(root) } as never, root, '../x')).dir).toBeNull()
  })

  it('a folder that is a link out of the project is never read, nor are links inside the folder', async () => {
    const root = project('madr')
    const outside = mkdtempSync(join(tmpdir(), 'adr-outside-'))

    cleanups.push(outside)
    writeFileSync(join(outside, '0001-secret.md'), '# 1. Secret\n\nStatus: Accepted\n')
    rmSync(join(root, 'docs/decisions'), { recursive: true })
    symlinkSync(outside, join(root, 'docs/decisions'))

    const state = stateAt(root)

    await loadAdrs(state, hostOfRoot(root).host as never)
    expect(adrOf(state).dir).toBeNull()
    expect(adrOf(state).why).toContain('is a link')
    expect(adrOf(state).registry.docs).toEqual([])

    const second = project('madr')

    symlinkSync(join(outside, '0001-secret.md'), join(second, 'docs/decisions/0009-link.md'))

    const next = stateAt(second)

    await loadAdrs(next, hostOfRoot(second).host as never)
    expect(adrOf(next).registry.docs.map(d => d.file)).not.toContain('0009-link.md')
    expect(adrOf(next).registry.docs).toHaveLength(3)
  })

  it('a setting names the folder; a link above the project root is not followed', async () => {
    const root = project('empty')

    mkdirSync(join(root, 'notes/decisions'), { recursive: true })
    writeFileSync(join(root, 'notes/decisions/0001-x.md'), '# 1. X\n\nStatus: Accepted\nDate: 2020-01-01\n')

    const state = stateAt(root)

    state.cwd = root

    const found = await discover({ fs: fsOfRoot(root) } as never, root, 'notes/decisions')

    expect(found.dir).toBe('notes/decisions')
  })
})

describe('writing, in a copy of each project', () => {
  const today = TODAY

  it('initialise creates the folder and the first record once, shows its exact path, and never overwrites', async () => {
    const { root, state, world } = await loaded('empty')
    const spec = initSpec(state, world.host as never, today)

    expect(spec?.label).toContain('docs/adr/0001-record-architecture-decisions.md')
    expect(spec?.shows).toContain('create docs/adr/0001-record-architecture-decisions.md')
    expect(existsSync(join(root, 'docs'))).toBe(false)
    await spec?.run?.()
    expect(readFileSync(join(root, 'docs/adr/0001-record-architecture-decisions.md'), 'utf8')).toContain('## Status\n\nAccepted')
    expect(adrOf(state).dir).toBe('docs/adr')
    expect(initSpec(state, world.host as never, today)).toBeNull()
    expect(world.log.toasts).toHaveLength(1)
    expect(world.log.toasts[0]).toMatchObject({ level: 'info' })
    expect(state.events.filter(event => event.kind === 'notices' && event.text.startsWith('adr:'))).toHaveLength(1)
  })

  it('initialise races a file that appears first: nothing is overwritten', async () => {
    const { root, state, world } = await loaded('empty')
    const spec = initSpec(state, world.host as never, today)

    mkdirSync(join(root, 'docs/adr'), { recursive: true })
    writeFileSync(join(root, 'docs/adr/0001-record-architecture-decisions.md'), 'MINE')
    await spec?.run?.()
    expect(readFileSync(join(root, 'docs/adr/0001-record-architecture-decisions.md'), 'utf8')).toBe('MINE')
    expect(adrOf(state).last?.ok).toBe(false)
    expect(world.log.toasts).toEqual([])
  })

  it.each([
    ['madr', 'docs/decisions', '0004-cache-reads.md', 'status: proposed'],
    ['nygard', 'doc/adr', '0004-cache-reads.md', '## Status\n\nProposed'],
    ['ruflo-style', 'docs/adrs', 'ADR-003-cache-reads.md', '**Status**: Proposed'],
    ['mixed', 'docs/architecture/decisions', '0005-cache-reads.md', 'Proposed'],
  ])('propose in %s takes the next number and the project’s file name and headings, and refuses an existing file', async (name, folder, file, marker) => {
    const { root, state, world } = await loaded(name)
    const spec = proposeSpec(state, world.host as never, 'Cache reads', today)

    expect(spec?.shows).toContain(`create ${folder}/${file}`)
    expect(existsSync(join(root, folder, file))).toBe(false)
    await spec?.run?.()

    const text = readFileSync(join(root, folder, file), 'utf8')

    expect(text).toContain(marker)
    expect(parseAdr(file, text)).toMatchObject({ status: 'proposed', title: 'Cache reads', date: today })
    expect(adrOf(state).selected).toBe(file)
    expect(world.log.toasts).toHaveLength(1)

    // A second proposal with the same title takes the next number, and a record that appears in between is not overwritten.
    const again = proposeSpec(state, world.host as never, 'Cache reads', today)
    const target = /create (\S+)/.exec(again?.shows ?? '')?.[1] as string

    writeFileSync(join(root, target), 'MINE')
    await again?.run?.()
    expect(readFileSync(join(root, target), 'utf8')).toBe('MINE')
  })

  it('propose with a hostile title cannot leave the folder or inject a heading, and an empty title is refused', async () => {
    const { root, state, world } = await loaded('nygard')

    expect(proposeSpec(state, world.host as never, '   ', today)).toBeNull()

    const spec = proposeSpec(state, world.host as never, '../../etc/passwd\n## Status\n\nAccepted [x](y) `z`', today)

    await spec?.run?.()

    const written = readdirSync(join(root, 'doc/adr')).filter(f => f.startsWith('0004'))

    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^0004-[a-z0-9-]+\.md$/)

    const text = readFileSync(join(root, 'doc/adr', written[0] as string), 'utf8')

    expect(text.match(/^## Status$/gm)).toHaveLength(1)
    expect(parseAdr(written[0] as string, text).status).toBe('proposed')
    expect(existsSync(join(root, 'etc'))).toBe(false)
  })

  it('a transition writes exactly the confirmed diff and nothing else, then re-reads', async () => {
    const { root, state, world } = await loaded('ruflo-style')
    const doc = adrOf(state).registry.docs[1] as AdrDoc
    const before = readFileSync(join(root, 'docs/adrs', doc.file), 'utf8')
    const spec = await statusSpec(state, world.host as never, doc, 'accepted')

    expect(spec?.label).toBe('mark ADR 2 accepted')
    expect(spec?.shows).toContain('-Status: Proposed (2025-02-01)')
    expect(spec?.shows).toContain('+Status: Accepted')
    expect(readFileSync(join(root, 'docs/adrs', doc.file), 'utf8')).toBe(before)
    await spec?.run?.()

    const after = readFileSync(join(root, 'docs/adrs', doc.file), 'utf8')

    expect(after).toBe(before.replace('Status: Proposed (2025-02-01)', 'Status: Accepted'))
    expect(adrOf(state).registry.docs[1]?.status).toBe('accepted')
    expect(world.log.toasts).toHaveLength(1)
  })

  it('a file that changed since the diff was shown is left alone', async () => {
    const { root, state, world } = await loaded('ruflo-style')
    const doc = adrOf(state).registry.docs[1] as AdrDoc
    const spec = await statusSpec(state, world.host as never, doc, 'accepted')

    writeFileSync(join(root, 'docs/adrs', doc.file), 'someone else edited this')
    await spec?.run?.()
    expect(readFileSync(join(root, 'docs/adrs', doc.file), 'utf8')).toBe('someone else edited this')
    expect(adrOf(state).last).toMatchObject({ ok: false })
    expect(adrOf(state).last?.lines.join(' ')).toContain('changed since the diff was shown')
    expect(world.log.toasts).toEqual([])
  })

  it('supersede edits both files with their own diffs, and a refused change says why', async () => {
    const { root, state, world } = await loaded('nygard')
    const docs = adrOf(state).registry.docs
    const accepted = docs[0] as AdrDoc
    const created = proposeSpec(state, world.host as never, 'Use gRPC', today)

    await created?.run?.()

    const newer = adrOf(state).registry.docs.find(doc => doc.number === 4) as AdrDoc

    expect(await planStatus(state, world.host as never, accepted, 'superseded', null)).toMatchObject({ ok: false })
    expect(await planStatus(state, world.host as never, accepted, 'accepted', null)).toMatchObject({ ok: false, why: 'it is already accepted' })
    expect(await planStatus(state, world.host as never, accepted, 'rejected', null)).toMatchObject({ ok: false })

    const spec = await statusSpec(state, world.host as never, accepted, 'superseded', newer)

    expect(spec?.expect).toContain(accepted.file)
    expect(spec?.expect).toContain(newer.file)
    await spec?.run?.()
    expect(readFileSync(join(root, 'doc/adr', accepted.file), 'utf8')).toContain('Superseded by [4. Use gRPC](0004-use-grpc.md)')
    expect(readFileSync(join(root, 'doc/adr', newer.file), 'utf8')).toContain('Supersedes [1. Record architecture decisions]')
    expect(adrOf(state).registry.docs.find(doc => doc.number === 1)?.status).toBe('superseded')
    expect(lint(adrOf(state).registry, adrOf(state).files).filter(f => f.code === 'supersede-mismatch' || f.code === 'dangling-supersedes')).toEqual([])
  })

  it('a record that is a link is never written through', async () => {
    const { root, state, world } = await loaded('nygard')
    const target = join(root, 'doc/adr', '0003-use-graphql.md')
    const outside = mkdtempSync(join(tmpdir(), 'adr-outside-'))

    cleanups.push(outside)

    const doc = adrOf(state).registry.docs[2] as AdrDoc
    const spec = await statusSpec(state, world.host as never, doc, 'deprecated')

    writeFileSync(join(outside, 'x.md'), readFileSync(target, 'utf8'))
    unlinkSync(target)
    symlinkSync(join(outside, 'x.md'), target)
    await spec?.run?.()
    expect(readFileSync(join(outside, 'x.md'), 'utf8')).toContain('Accepted')
    expect(readFileSync(join(outside, 'x.md'), 'utf8')).not.toContain('Deprecated')
    expect(adrOf(state).last?.lines.join(' ')).toContain('link')
  })
})

// ---------------------------------------------------------------------------------------------------------------- mutation check

type Mod = Record<string, (...args: never[]) => unknown>

/** What the pure modules say about a fixed battery: any change in a module's behaviour that the battery sees changes this string. */
function signature(adr: Mod, scope: Mod, write: Mod): string {
  const parse = adr.parseAdr as unknown as (f: string, t: string) => AdrDoc
  const index = adr.indexOf as unknown as typeof indexOf
  const lintFn = adr.lint as unknown as typeof lint
  const out: unknown[] = []
  const real = readdirSync(RUFLO_ADRS).filter(f => /^ADR-.*\.md$/.test(f)).slice(0, 120).map(f => parse(f, readFileSync(join(RUFLO_ADRS, f), 'utf8')))
  const fixtures: AdrDoc[] = []

  for (const [name, folder] of [['madr', 'docs/decisions'], ['nygard', 'doc/adr'], ['ruflo-style', 'docs/adrs'], ['mixed', 'docs/architecture/decisions'], ['plain', 'adr'], ['log4brains', 'docs/adr']]) {
    for (const f of readdirSync(join(FIXTURES, name as string, folder as string)).filter(file => file.endsWith('.md') && !/^readme/i.test(file))) fixtures.push(parse(f, readFileSync(join(FIXTURES, name as string, folder as string, f), 'utf8')))
  }

  out.push(real.map(d => [d.number, d.variant, d.status, d.date, d.scope.length, d.supersedes, d.supersededBy, d.relates, d.refs, d.decision.length, d.format]))
  out.push(fixtures.map(d => [d.status, d.date, d.format, d.supersedes, d.supersededBy, d.refs, d.scope, d.title]))
  out.push(lintFn(index([...real, ...fixtures]), real.map(d => d.file), 'ADR-001 ADR-002').map(f => `${f.code}:${f.file}`))
  out.push(lintFn(index(fixtures.filter(d => d.file.startsWith('00'))), [], null).map(f => `${f.code}:${f.file}`))
  out.push(parse('0001-x.md', `# 1. X\n\nStatus: Accepted\n\u001b[31m${'z'.repeat(MAX_FILE + 50)}`).notes)
  out.push(parse('0001-x.md', '---\nstatus: accepted\ndate: 2024-12-31\n---\n\n# X\n').date)
  out.push(parse('0001-x.md', '# X\n\nStatus: Accepted\u001b[2K bold\nDate: 2024-02-09\n').statusRaw)
  out.push(parse('0001-x.md', '# X\n\n## Status\n\nSuperseded by [2. Y](0002-y.md)\n'))
  out.push(parse('0001-x.md', `# X\n\n${'filler '.repeat(40_000)}\n\nStatus: Accepted\n`).status)
  out.push(parse('ADR-376-x.md', '# ADR-376: X\n\n| Field | Value |\n|---|---|\n| Status | Proposed |\n').status)
  out.push(lintFn(index([parse('0001-a.md', '# 1. A\n\nStatus: Accepted\nDate: 2020-01-01\nSupersedes: 2\n'), parse('0002-b.md', '# 2. B\n\nStatus: Accepted\nDate: 2020-01-01\nSupersedes: 1\n')]), []).map(f => `${f.level}:${f.code}`))

  const hits = scope.checkScope as unknown as typeof checkScope
  const hit = scope.scopeHits as unknown as typeof scopeHits
  const block = scope.digestBlock as unknown as typeof digestBlock
  const sug = scope.suggest as unknown as typeof suggest
  const accepted = parse('0001-a.md', '# 1. Auth sessions\n\nStatus: Accepted\nDate: 2025-01-01\n\n## Decision\n\nUse sessions.\n')
  const proposed = parse('0002-b.md', '# 2. Auth tokens\n\nStatus: Proposed\nDate: 2025-01-01\n')

  accepted.scope = ['src/auth']
  proposed.scope = ['src/auth']
  out.push([hit('src/auth', 'src/auth/a.ts'), hit('src/auth', 'src/authz/a.ts'), hit('a/b.ts', 'x/a/b.ts'), hit('src/*.ts', 'src/deep/a.ts'), hit('docs', 'docs/x.md')])
  out.push(hits(['src/auth/a.ts', 'src/other.ts'], [accepted, proposed]).hits.map(h => h.file))
  out.push(block([accepted, proposed, ...Array.from({ length: 10 }, (_v, i) => ({ ...accepted, file: `00${i + 10}-z.md`, number: i + 10, decision: 'lorem ipsum '.repeat(40) }))]).length)
  const history = { ...accepted, file: '0003-c.md', number: 3, status: 'superseded' as const }

  out.push(sug('auth sessions src/auth/x.ts', [accepted, proposed, history]).map(s => s.doc.number))

  const style = (write.detectStyle as unknown as typeof detectStyle)(fixtures.filter(d => d.file.startsWith('ADR-')))

  out.push([style, (write.nextNumber as unknown as typeof nextNumber)(fixtures), (write.slugOf as unknown as typeof slugOf)('Use Postgres — for Storage!')])

  const nygard = parse('0003-use-graphql.md', readFileSync(join(FIXTURES, 'nygard', 'doc/adr', '0003-use-graphql.md'), 'utf8'))
  const edited = (write.withStatus as unknown as typeof withStatus)(readFileSync(join(FIXTURES, 'nygard', 'doc/adr', '0003-use-graphql.md'), 'utf8'), nygard, { name: 'nygard', width: 4, pattern: '{n}-{slug}.md', source: 'default' }, 'deprecated')

  out.push(edited)

  return JSON.stringify(out)
}

describe('mutation check: the battery notices a change in the parser, the lint, the scope matcher and the writer', () => {
  const data = join(HERE, '..', 'hooks', 'data')
  const made: string[] = []
  const baseline = async () => signature(await import('../hooks/data/adr') as never, await import('../hooks/data/adr-scope') as never, await import('../hooks/data/adr-write') as never)

  afterAll(() => {
    for (const file of made) rmSync(file, { force: true })
  })

  const mutants: [string, string, string, string][] = [
    ['adr', 'a superseded status read as deprecated', "if (/\\bsuperse?ded\\b|\\breplaced\\b|\\bobsolete/.test(text)) return 'superseded'", "if (/\\bsuperse?ded\\b|\\breplaced\\b|\\bobsolete/.test(text)) return 'deprecated'"],
    ['adr', 'a one-digit month only', '(0?[1-9]|1[0-2])[-/. ](0?[1-9]|[12]\\d|3[01])', '(0?[1-9])[-/. ](0?[1-9]|[12]\\d|3[01])'],
    ['adr', 'A/B/C siblings counted as duplicates', 'other.variant === doc.variant', 'true'],
    ['adr', 'a supersedes with no file not reported', '!registry.byNumber.has(target)) add(\'warn\', \'dangling-supersedes\'', 'registry.byNumber.has(target)) add(\'warn\', \'dangling-supersedes\''],
    ['adr', 'a Status section read as a status line', "return { raw: first ?? '', format: 'nygard', section }", "return { raw: first ?? '', format: 'inline', section }"],
    ['adr', 'front matter never recognised', "if (!text.startsWith('---\\n')) return null", "if (!text.startsWith('--\\n')) return null"],
    ['adr', 'escapes left in the text', ".replace(ESCAPES, '')", ''],
    ['adr', 'no cap on a huge file', 'text = wash(source.length > MAX_FILE ? source.slice(0, MAX_FILE) : source)', 'text = wash(source)'],
    ['adr', 'a table status not read', "const table = /^\\s*\\|\\s*\\**status\\**\\s*\\|\\s*(.+?)\\s*\\|?\\s*$/i.exec(line)", "const table = /^\\s*\\|\\s*\\**nostatus\\**\\s*\\|\\s*(.+?)\\s*\\|?\\s*$/i.exec(line)"],
    ['adr', 'a cycle not reported', "add('error', 'supersede-cycle'", "add('info', 'supersede-cycle'"],
    ['adr-scope', 'a sibling that shares a prefix counted in scope', 'f.startsWith(`${e}/`)', 'f.startsWith(e)'],
    ['adr-scope', 'a proposed ADR counted as in force', "attached.filter(doc => doc.status === 'accepted')", 'attached'],
    ['adr-scope', 'no cap on the digest', 'if (used + line.length > DIGEST_TOTAL) break', ''],
    ['adr-scope', 'a glob that crosses folders', "'[^/]*'", "'.*'"],
    ['adr-scope', 'history offered as a suggestion', "(doc.status !== 'accepted' && doc.status !== 'proposed') || attached.includes(doc.file)", 'attached.includes(doc.file)'],
    ['adr-write', 'the next number reuses the highest', "(high, doc) => Math.max(high, doc.number ?? 0), 0) + 1", "(high, doc) => Math.max(high, doc.number ?? 0), 0) + 0"],
    ['adr-write', 'a status inserted instead of replaced', 'lines[first] = value', "lines.splice(first, 0, value)"],
    ['adr-write', 'slugs keep their case', '    .toLowerCase()\n    .normalize', '    .normalize'],
    ['adr-write', 'the prefix is never detected', "/^adr[-_ ]/i.test(doc.file)", '/^zzz/i.test(doc.file)'],
  ]

  it('the unmutated battery is stable', async () => {
    expect(await baseline()).toBe(await baseline())
  })

  it.each(mutants.map((m, i) => [i, m[1], m] as const))('mutant %i (%s) changes what the battery sees', async (index, _label, [module, , find, replace]) => {
    const file = join(data, `${module}.ts`)
    const source = readFileSync(file, 'utf8')

    expect(source, `the mutation target must exist: ${find}`).toContain(find)

    const path = join(data, `.mut-${index}-${module}.ts`)

    writeFileSync(path, source.replace(find, replace))
    made.push(path)

    const mod = async (name: string) => (name === module ? await import(/* @vite-ignore */ path) : await import(`../hooks/data/${name}`)) as Mod

    expect(signature(await mod('adr'), await mod('adr-scope'), await mod('adr-write'))).not.toBe(await baseline())
  })
})

void [cpSync, withStatus, graphOf]
