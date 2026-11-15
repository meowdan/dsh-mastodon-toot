/**
 * lib/sources.mjs —— 发帖素材从哪来
 * 每一块都「拿得到就用，拿不到就空着」，绝不编内容填空。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { readJson, writeJson } from './store.mjs'

const UA = 'dsh-mastodon-toot/0.1.0'

export async function fetchText(url, { timeoutMs = 12000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return await res.text()
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim()
}

export function rssItems(xml, limit = 30) {
  const out = []
  const re = /<item\b[\s\S]*?<\/item>/gi
  let m
  while ((m = re.exec(xml)) && out.length < limit) {
    const block = m[0]
    const title = decodeEntities((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1])
    const link = decodeEntities((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1])
    if (title) out.push({ title, link })
  }
  return out
}

const WMO = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
}

export async function weatherMaterial(cfg) {
  const lat = Number(cfg.lat) || 23.1291
  const lon = Number(cfg.lon) || 113.2644
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto'
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return ''
    const j = await res.json()
    const c = j.current || {}
    if (c.temperature_2m === undefined) return ''
    const t = Math.round(Number(c.temperature_2m))
    const w = WMO[Number(c.weather_code)] || ''
    const city = String(cfg.city || '本地').trim()
    return `${city}现在 ${t}℃，${w}，湿度 ${Math.round(Number(c.relative_humidity_2m))}%，风 ${Math.round(Number(c.wind_speed_10m))} km/h`
  } catch {
    return ''
  }
}

export async function newsMaterial(limit = 3) {
  const feeds = [
    'https://www.solidot.org/index.rss',
    'https://www.ithome.com/rss/',
  ]
  const pool = []
  for (const f of feeds) {
    try {
      const items = rssItems(await fetchText(f, { timeoutMs: 12000 }), 15)
      pool.push(...items)
    } catch { /* 这个源挂了就算了 */ }
  }
  if (!pool.length) return ''
  const pick = []
  const used = new Set()
  while (pick.length < limit && used.size < pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    if (used.has(i)) continue
    used.add(i)
    pick.push(pool[i].title)
  }
  return pick.map((t, i) => `${i + 1}. ${t}`).join('\n')
}

export async function githubMaterial(limit = 3) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
  const url = `https://api.github.com/search/repositories?q=stars:%3E200+created:%3E${since}&sort=stars&order=desc&per_page=8`
  const headers = { accept: 'application/vnd.github+json' }
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(12000) })
    if (!res.ok) return ''
    const j = await res.json()
    const items = (j.items || []).slice(0, limit)
    return items.map((r) => `${r.full_name}（★${r.stargazers_count}）：${String(r.description || '').slice(0, 80)}`).join('\n')
  } catch {
    return ''
  }
}

// 博客：读 RSS，按 guid/link 去重 45 天
export async function blogMaterial(dir, limit = 1) {
  try {
    const xml = await fetchText('https://blog.meowdan.com/rss.xml', { timeoutMs: 12000 })
    const items = rssItems(xml, 10)
    if (!items.length) return ''
    const seen = readJson(join(dir, 'state', 'blog_seen.json'), {})
    const cutoff = Date.now() - 45 * 86400_000
    const fresh = items.filter((it) => {
      const key = it.link || it.title
      const t = Number(seen[key] || 0)
      return !t || t < cutoff
    })
    const pick = (fresh.length ? fresh : items).slice(0, limit)
    for (const it of pick) seen[it.link || it.title] = Date.now()
    writeJson(join(dir, 'state', 'blog_seen.json'), seen)
    return pick.map((it) => `《${it.title}》 ${it.link}`).join('\n')
  } catch {
    return ''
  }
}

// DSH 插件市场：最近发布的插件。给「插件世界发生了什么」这一路素材。
export async function pluginsMaterial(cfg) {
  const url = String(cfg.marketIndexUrl || '').trim()
    || 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return ''
    const j = await res.json()
    const list = Array.isArray(j) ? j : (Array.isArray(j.plugins) ? j.plugins : [])
    if (!list.length) return ''
    const cutoff = Date.now() - 21 * 86400_000
    const recent = []
    for (const p of list) {
      const v = Array.isArray(p.versions) && p.versions.length ? p.versions[0] : null
      const ts = v ? Date.parse(v.publishTimestamp || '') : NaN
      if (!Number.isFinite(ts) || ts < cutoff) continue
      const zh = (p.description && (p.description.zh || p.description.en)) || ''
      if (!zh) continue
      recent.push({ name: p.name || p.title || '', desc: String(zh), ts })
    }
    if (!recent.length) return ''
    recent.sort((a, b) => b.ts - a.ts)
    const pick = recent[Math.floor(Math.random() * Math.min(6, recent.length))]
    return `插件 ${pick.name}：${pick.desc.slice(0, 140)}`
  } catch {
    return ''
  }
}

/* ───────────── 队列：把「对话 / B 站看过的」变成待发 ───────────── */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const PRIVACY_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b|C:\\|%USERPROFILE%|token|password|密码|密钥|飞牛|内网|nas\b|192\.168\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\./i

function paragraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
}

function sectionOf(md, heading) {
  const lines = String(md || '').split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()))
  if (start < 0) return ''
  const buf = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    buf.push(lines[i])
  }
  return buf.join('\n')
}

function recentFiles(dirPath, days = 7) {
  if (!existsSync(dirPath)) return []
  const cutoff = Date.now() - days * 86400_000
  const out = []
  for (const name of readdirSync(dirPath)) {
    if (!name.endsWith('.md')) continue
    const p = join(dirPath, name)
    try {
      if (statSync(p).mtimeMs >= cutoff) out.push(p)
    } catch { /* 跳过 */ }
  }
  return out
}

function sha1(s) {
  return createHash('sha1').update(s).digest('hex')
}

/**
 * 扫旧管道产物：bili-duty/out/*.md 的「## 长毛象待发」段 + conv/*.md 整篇。
 * 返回新条目（已过滤隐私、已去重），并把 seen 记进 state。
 */
export function ingestQueue(dir, cfg, state) {
  const base = String(cfg.biliQueueDir || '').trim() || join(dshHome(), 'bili-duty')
  const seen = readJson(join(dir, 'state', 'queue_seen.json'), {})
  const seenCut = Date.now() - 30 * 86400_000
  const items = []
  const take = (text, source) => {
    for (const p of paragraphs(text)) {
      if (PRIVACY_RE.test(p)) continue
      const id = sha1(p)
      if (seen[id] && seen[id] > seenCut) continue
      seen[id] = Date.now()
      items.push({ id, text: p.slice(0, 1200), source, dueAt: 0 })
    }
  }
  if (cfg.biliSource !== false) {
    for (const p of recentFiles(join(base, 'out'), 7)) {
      take(sectionOf(readFileSync(p, 'utf8'), '## 长毛象待发'), 'bili')
    }
  }
  if (cfg.convSource !== false) {
    for (const p of recentFiles(join(base, 'conv'), 7)) {
      take(readFileSync(p, 'utf8'), 'conv')
    }
  }
  if (items.length) writeJson(join(dir, 'state', 'queue_seen.json'), capSeen(seen))
  return items
}

function capSeen(seen) {
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 3000)
  return Object.fromEntries(entries)
}
