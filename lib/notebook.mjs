/**
 * lib/notebook.mjs —— 小本本
 * 三本：
 *   interactions.jsonl  互动流水（一进一出都记；不记原因就等于没记）
 *   people.json         人物卡（这人是谁、聊过什么、雷区）
 *   promises.json       答应过的事（最伤信任的就是「答应了又忘」）
 * 全部本机；notebook=off 时上层直接不调用。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendJsonl } from './store.mjs'

const MAX_TEXT = 4000

function nbDir(dir) {
  return join(dir, 'notebook')
}
function pFile(dir) { return join(nbDir(dir), 'people.json') }
function iFile(dir) { return join(nbDir(dir), 'interactions.jsonl') }
function mFile(dir) { return join(nbDir(dir), 'promises.json') }

function readObj(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

function writeObj(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

const norm = (acct) => String(acct || '').replace(/^@/, '').trim().toLowerCase()
const cut = (s, n = MAX_TEXT) => String(s || '').slice(0, n)

export function loadPeople(dir) {
  return readObj(pFile(dir), {})
}

export function savePeople(dir, people) {
  writeObj(pFile(dir), people)
}

/** 认识一个人（或更新最后见面） */
export function touchPerson(dir, account, extra = {}) {
  const acct = norm(account?.acct)
  if (!acct) return null
  const people = loadPeople(dir)
  const now = Date.now()
  const prev = people[acct] || {
    acct,
    id: String(account?.id || ''),
    display: String(account?.displayName || account?.username || ''),
    note: '',
    tags: [],
    firstSeen: now,
    count: 0,
  }
  const next = {
    ...prev,
    id: prev.id || String(account?.id || ''),
    display: String(account?.displayName || prev.display || ''),
    lastSeen: now,
    count: Number(prev.count || 0) + (extra.count ? 1 : 0),
  }
  if (extra.note !== undefined) next.note = cut(extra.note)
  if (Array.isArray(extra.tags)) next.tags = [...new Set(extra.tags.map((t) => cut(t, 40)).filter(Boolean))].slice(0, 30)
  people[acct] = next
  savePeople(dir, people)
  return next
}

export function setNote(dir, acctRaw, note, tags) {
  const acct = norm(acctRaw)
  if (!acct) throw new Error('缺 acct')
  const people = loadPeople(dir)
  const prev = people[acct] || { acct, id: '', display: '', note: '', tags: [], firstSeen: Date.now(), count: 0 }
  people[acct] = {
    ...prev,
    note: cut(note),
    tags: Array.isArray(tags) ? [...new Set(tags.map((t) => cut(t, 40)).filter(Boolean))].slice(0, 30) : prev.tags,
  }
  savePeople(dir, people)
  return people[acct]
}

export function listPeople(dir, { limit = 50, q = '' } = {}) {
  const people = loadPeople(dir)
  const needle = String(q || '').toLowerCase()
  return Object.values(people)
    .filter((p) => !needle || p.acct.includes(needle) || String(p.note || '').toLowerCase().includes(needle))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, Math.max(1, Math.min(500, limit)))
}

/**
 * 记一条互动。
 * row = {kind, acct, statusId, threadId, direction, text, reply, why, model, latencyMs}
 */
export function recordInteraction(dir, row) {
  const acct = norm(row.acct)
  appendJsonl(iFile(dir), {
    t: Date.now(),
    kind: cut(row.kind || 'reply', 20),
    acct,
    statusId: row.statusId ? String(row.statusId) : '',
    threadId: row.threadId ? String(row.threadId) : '',
    direction: row.direction === 'out' ? 'out' : 'in',
    text: cut(row.text),
    reply: cut(row.reply),
    why: cut(row.why, 200),
    model: cut(row.model, 120),
    latencyMs: Number(row.latencyMs) || 0,
  })
}

/** 读最近 N 条流水（可选按 acct 过滤） */
export function recentInteractions(dir, { acct = '', limit = 20 } = {}) {
  const p = iFile(dir)
  if (!existsSync(p)) return []
  let lines = []
  try {
    const raw = readFileSync(p, 'utf8')
    lines = raw.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
  const target = norm(acct)
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i])
      if (!target || row.acct === target) out.push(row)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

export function addPromise(dir, { acct, text, due = 0 }) {
  const list = readObj(mFile(dir), [])
  const row = {
    id: randomUUID().slice(0, 8),
    acct: norm(acct),
    text: cut(text, 500),
    due: Number(due) || 0,
    status: 'open',
    createdAt: Date.now(),
  }
  list.push(row)
  writeObj(mFile(dir), list)
  return row
}

export function resolvePromise(dir, id, status = 'done') {
  const list = readObj(mFile(dir), [])
  const row = list.find((x) => x.id === id)
  if (!row) throw new Error('没找到这条承诺')
  row.status = status === 'dropped' ? 'dropped' : 'done'
  row.doneAt = Date.now()
  writeObj(mFile(dir), list)
  return row
}

export function listPromises(dir, { status = 'open', acct = '' } = {}) {
  const list = readObj(mFile(dir), []).filter((x) => !status || x.status === status)
  const target = norm(acct)
  return (target ? list.filter((x) => x.acct === target) : list).sort((a, b) => b.createdAt - a.createdAt)
}

/** 给回复引擎的上下文：这个人 + 最近几句 + 还没兑现的承诺 */
export function contextFor(dir, acctRaw, { limit = 6 } = {}) {
  const acct = norm(acctRaw)
  const person = loadPeople(dir)[acct] || null
  const recent = recentInteractions(dir, { acct, limit }).reverse()
  const promises = listPromises(dir, { status: 'open', acct })
  return { person, recent, promises }
}

/** 一天/一周的摘要，给小本本页面和「记得住」用 */
export function digest(dir, days = 7) {
  const since = Date.now() - days * 86400_000
  const p = iFile(dir)
  if (!existsSync(p)) return { days, total: 0, people: 0, replies: 0, skips: 0, top: [] }
  let total = 0
  let replies = 0
  let skips = 0
  const byAcct = new Map()
  try {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!row.t || row.t < since) continue
      total++
      if (row.kind === 'skip') skips++
      else replies++
      if (row.acct) byAcct.set(row.acct, (byAcct.get(row.acct) || 0) + 1)
    }
  } catch { /* 空 */ }
  const top = [...byAcct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([acct, n]) => ({ acct, n }))
  return { days, total, people: byAcct.size, replies, skips, top }
}

/** 超期流水清掉（人物卡与承诺不动） */
export function prune(dir, retentionDays = 180) {
  const p = iFile(dir)
  if (!existsSync(p)) return 0
  const cutoff = Date.now() - Math.max(7, retentionDays) * 86400_000
  const keep = []
  let dropped = 0
  try {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row.t >= cutoff) keep.push(line)
        else dropped++
      } catch { dropped++ }
    }
  } catch {
    return 0
  }
  if (dropped) {
    const tmp = `${p}.tmp-${process.pid}`
    writeFileSync(tmp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8')
    renameSync(tmp, p)
  }
  return dropped
}
