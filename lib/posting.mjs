/**
 * lib/posting.mjs —— 什么时候发、发什么、发完记哪儿
 * 排期按日期种子随机：同一天刷新几次都是同一组点，但每天不一样，不搞固定钟点。
 * 队列（对话/B站）另走一条：到点一条一条慢慢发，不一次刷屏。
 */
import { createHash } from 'node:crypto'
import { readJson, writeJson } from './store.mjs'
import { ingestQueue } from './sources.mjs'
import { api } from './masto.mjs'

const DAY = 86400_000

function hash32(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function tzParts(tz, at = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]))
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday]
  return {
    ms: at,
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: wd,
  }
}

function parseHM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return fallback
  return Math.min(23 * 60 + 59, Math.max(0, Number(m[1]) * 60 + Number(m[2])))
}

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** 当天的随机发帖点（同一天稳定） */
export function slotsFor(dateKey, cfg) {
  const start = parseHM(cfg.windowStart, 9 * 60 + 40)
  const end = parseHM(cfg.windowEnd, 17 * 60 + 50)
  const span = Math.max(60, end - start)
  const gap = Math.max(10, Number(cfg.minGapMin) || 45)
  let lo = Math.max(1, Number(cfg.dailyMin) || 7)
  let hi = Math.max(lo, Number(cfg.dailyMax) || 10)
  const maxFit = Math.max(1, Math.floor(span / gap))
  hi = Math.min(hi, maxFit)
  lo = Math.min(lo, hi)
  const rnd = mulberry32(hash32(`${dateKey}|${cfg.instance || 'mastodon'}|${start}|${end}`))
  const count = lo + Math.floor(rnd() * (hi - lo + 1))
  const seg = span / count
  const out = []
  for (let i = 0; i < count; i++) {
    const jitter = (rnd() - 0.5) * seg * 0.5
    let t = Math.round(start + i * seg + seg / 2 + jitter)
    t = Math.max(start, Math.min(end, t))
    out.push(t)
  }
  out.sort((a, b) => a - b)
  for (let i = 1; i < out.length; i++) {
    if (out[i] - out[i - 1] < gap) out[i] = Math.min(end, out[i - 1] + gap)
  }
  return out.filter((t, i) => i === 0 || t !== out[i - 1]).map(hm)
}

/** 今天还要不要发；返回那个 slot 或 null */
export function dueSlot(state, cfg, now) {
  if (typeof now === 'number') now = tzParts(cfg.tz, now)
  if (!now) now = tzParts(cfg.tz)
  if (!cfg.postingEnabled || state.paused) return null
  if (cfg.weekdaysOnly !== false && (now.weekday === 0 || now.weekday === 6)) return null
  let posting = state.posting
  if (!posting || posting.date !== now.date) {
    posting = { date: now.date, slots: slotsFor(now.date, cfg), used: [] }
    state.posting = posting
  }
  posting.used = Array.isArray(posting.used) ? posting.used : []
  posting.slots = Array.isArray(posting.slots) && posting.slots.length ? posting.slots : slotsFor(now.date, cfg)
  const grace = Math.max(1, Number(cfg.graceMin) || 120)
  const gapMs = Math.max(10, Number(cfg.minGapMin) || 45) * 60000
  if (posting.lastAt && now.ms - posting.lastAt < gapMs) return null
  for (const s of posting.slots) {
    if (posting.used.includes(s)) continue
    const m = parseHM(s, -1)
    if (m < 0) continue
    if (now.minutes >= m && now.minutes <= m + grace) return s
    if (now.minutes < m) break
  }
  return null
}

export async function publish(creds, text, { visibility = 'public' } = {}) {
  const key = createHash('sha1').update(text).digest('hex').slice(0, 32)
  const { data } = await api(creds, '/api/v1/statuses', {
    method: 'POST',
    body: { status: text, visibility },
    headers: { 'Idempotency-Key': key },
    timeoutMs: 20000,
  })
  return { id: String(data?.id || ''), url: String(data?.url || '') }
}

export function recordPosted(dir, { hash, id, url, source }) {
  const p = `${dir}/state/posted.json`
  const ledger = readJson(p, {})
  ledger[hash || id] = { id, url, source: source || 'compose', at: Date.now() }
  const entries = Object.entries(ledger).sort((a, b) => b[1].at - a[1].at).slice(0, 300)
  writeJson(p, Object.fromEntries(entries))
}

/** 把新条目塞进队列：每条错开 4–12 分钟，像人一条条发 */
export function enqueue(state, dir, cfg, items) {
  const q = Array.isArray(state.queue) ? state.queue : []
  const now = Date.now()
  let cursor = Math.max(now, ...q.filter((x) => !x.postedAt).map((x) => x.dueAt || now))
  const minGap = Math.max(1, Number(cfg.queueGapMin) || 4) * 60000
  const maxGap = Math.max(minGap, Number(cfg.queueGapMax) || 12) * 60000
  for (const it of items) {
    cursor += minGap + Math.random() * (maxGap - minGap)
    q.push({ id: it.id, text: it.text, source: it.source, dueAt: cursor })
  }
  state.queue = q.filter((x) => !x.postedAt || now - x.postedAt < 7 * DAY).slice(-100)
  return items.length
}

/** 队列里该发的一条（一次只发一条） */
export function dueQueueItem(state, now = Date.now()) {
  const q = Array.isArray(state.queue) ? state.queue : []
  const due = q.filter((x) => !x.postedAt && x.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)
  return due[0] || null
}

export function markQueuePosted(state, id) {
  const it = (state.queue || []).find((x) => x.id === id)
  if (it) it.postedAt = Date.now()
}

export function ingestIfNeeded(state, dir, cfg) {
  if (cfg.queueEnabled === false) return 0
  if (cfg.biliSource === false && cfg.convSource === false) return 0
  try {
    const items = ingestQueue(dir, cfg, state)
    return enqueue(state, dir, cfg, items)
  } catch {
    return 0
  }
}
