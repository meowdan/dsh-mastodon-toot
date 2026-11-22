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

export function recordPosted(dir, { hash, id, url, source, n, text }) {
  const p = `${dir}/state/posted.json`
  const ledger = readJson(p, {})
  ledger[hash || id] = {
    id,
    url,
    source: source || 'compose',
    at: Date.now(),
    // 存全文及归一化版；0.3.15 查重会读这两份，不再只靠 hash
    n: String(n || ''),
    text: String(text || ''),
  }
  const entries = Object.entries(ledger).sort((a, b) => b[1].at - a[1].at).slice(0, 300)
  writeJson(p, Object.fromEntries(entries))
}

/**
 * 发帖数据：从本机账本（state/posted.json，最多 300 条）里数，不额外维护计数。
 * 返回今天 / 最近 N 天日条数 / 来源分布 / 最后一条，给设置页「发帖」那页显示。
 */
export function postStats(dir, { days = 7, now = Date.now() } = {}) {
  const ledger = readJson(`${dir}/state/posted.json`, {})
  const rows = Object.values(ledger || {}).filter((r) => r && Number(r.at) > 0)
  const pad = (n) => String(n).padStart(2, '0')
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const daily = []
  let week = 0
  for (let i = days - 1; i >= 0; i--) {
    const from = dayStart.getTime() - i * DAY
    const to = from + DAY
    const n = rows.filter((r) => r.at >= from && r.at < to).length
    week += n
    const d = new Date(from)
    daily.push({ date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, n })
  }
  const windowStart = dayStart.getTime() - (days - 1) * DAY
  const bySource = new Map()
  for (const r of rows) {
    if (r.at < windowStart) continue
    const k = String(r.source || 'compose')
    bySource.set(k, (bySource.get(k) || 0) + 1)
  }
  const lastRow = rows.length ? rows.reduce((a, b) => (b.at > a.at ? b : a)) : null
  return {
    days,
    total: rows.length,
    today: daily.length ? daily[daily.length - 1].n : 0,
    week,
    daily,
    bySource: [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([source, n]) => ({ source, n })),
    last: lastRow ? { at: lastRow.at, source: lastRow.source || 'compose', url: lastRow.url || '' } : null,
  }
}

/** 把新条目塞进队列：每条错开 4–12 分钟，像人一条条发 */
export function enqueue(state, dir, cfg, items) {
  const q = Array.isArray(state.queue) ? state.queue : []
  const now = Date.now()
  // 已在队列里的条目，dueAt 再离谱也只当作 now+6h 的游标，避免一条未来时间把后面的全推远
  const horizon = now + 6 * 3600 * 1000
  let cursor = Math.max(now, ...q.filter((x) => !x.postedAt).map((x) => Math.min(x.dueAt || now, horizon)))
  // 分钟先算好再乘 60000（原先 maxGap 拿 ms 当分钟乘，一条就被推到 166 天后）
  const minMin = Math.max(1, Number(cfg.queueGapMin) || 4)
  const maxMin = Math.max(minMin, Number(cfg.queueGapMax) || 12)
  const minGap = minMin * 60000
  const maxGap = maxMin * 60000
  for (const it of items) {
    cursor += minGap + Math.random() * (maxGap - minGap)
    q.push({ id: it.id, text: it.text, source: it.source, dueAt: cursor })
  }
  state.queue = q.filter((x) => !x.postedAt || now - x.postedAt < 7 * DAY).slice(-100)
  return items.length
}

/** 把被推到未来的条目拉回来：超过 now+6h 的当成坏的，重排成 now 起一条条错开 */
export function normalizeQueue(state, cfg, now = Date.now()) {
  const q = Array.isArray(state.queue) ? state.queue : []
  const horizon = now + 6 * 3600 * 1000
  const bad = q.filter((x) => !x.postedAt && Number(x.dueAt) > horizon)
  if (!bad.length) return 0
  bad.sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
  // 分钟先算好再乘 60000（原先 maxGap 拿 ms 当分钟乘，一条就被推到 166 天后）
  const minMin = Math.max(1, Number(cfg.queueGapMin) || 4)
  const maxMin = Math.max(minMin, Number(cfg.queueGapMax) || 12)
  const minGap = minMin * 60000
  const maxGap = maxMin * 60000
  let cursor = now + 60000
  for (const x of bad) {
    x.dueAt = cursor
    cursor += minGap + Math.random() * (maxGap - minGap)
  }
  state.queue = q
  return bad.length
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

/** 把条目移出队列（真重复/超龄放弃时用），返回是否删掉了 */
export function removeQueueItem(state, id) {
  const q = Array.isArray(state.queue) ? state.queue : []
  const before = q.length
  state.queue = q.filter((x) => x.id !== id)
  return state.queue.length < before
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
