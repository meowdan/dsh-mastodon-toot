/**
 * lib/store.mjs —— 配置、凭证、状态、日志的读写
 * 规则：家目录里的一切都是插件自己的；读坏了就退回默认值，不能因为一个坏 JSON 让插件不激活。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_DEFAULTS = Object.freeze({
  autoReply: true,          // 默认开：只回 @，边界清楚（会拿用户账号说话，首次要测试连接）
  autoPost: false,          // 发帖默认关
  scope: 'mentions',        // mentions / mentions+owner / all
  ownerAcct: '',
  allowlist: [],
  blocklist: [],
  maxPerDayOwner: 16,
  maxPerDayOthers: 10,
  perThreadHuman: 2,
  perThreadBot: 1,
  timelineProb: 0.85,
  sinceHours: 20,
  // 互动分组：主人 / 好友（互关）/ 其他人。不按概率，按开关 + 每日额度 + 冷却。
  replyOwnerEnabled: true,
  replyOwnerMentions: true,
  replyOwnerTimeline: true,
  replyOwnerMaxPerDay: 0,      // 0 = 不限
  replyOwnerPerThread: 3,
  replyOwnerMinGapMin: 2,
  replyFriendEnabled: true,
  replyFriendMentions: true,
  replyFriendTimeline: true,
  replyFriendMaxPerDay: 12,
  replyFriendPerThread: 2,
  replyFriendMinGapMin: 10,
  replyOtherEnabled: true,
  replyOtherMentions: true,
  replyOtherTimeline: false,
  replyOtherMaxPerDay: 8,
  replyOtherPerThread: 1,
  replyOtherMinGapMin: 15,
  replyVisibility: 'unlisted', // public / unlisted / private
  nightPause: true,
  language: 'zh',
  vision: false,
  replyMaxChars: 160,
  notebook: 'local',        // local / local+mnemon / off
  retentionDays: 180,
  storeText: true,
  pollSec: 30,
  dryRun: false,
  llmProvider: '',
  llmModel: '',
  // 发帖
  postingEnabled: false,
  dailyMin: 7,
  dailyMax: 10,
  windowStart: '09:40',
  windowEnd: '17:50',
  minGapMin: 45,
  graceMin: 120,
  weekdaysOnly: true,
  tz: 'Asia/Shanghai',
  city: '广州',
  lat: 23.1291,
  lon: 113.2644,
  queueEnabled: true,
  queueGapMin: 4,
  queueGapMax: 12,
  biliSource: true,
  convSource: true,
  biliQueueDir: '',
  srcWeather: true,
  srcNews: true,
  srcGithub: true,
  srcBlog: true,
  srcPlugins: true,
  srcChat: true,             // 和主人的对话（读本机会话日志，隐私过滤后当素材）
  chatSinceHours: 24,
  chatSessionsDir: '',
  personaFile: '',
  personaText: '',
  marketIndexUrl: '',
})

const BOOL_KEYS = [
  'autoReply', 'autoPost', 'nightPause', 'vision', 'storeText', 'dryRun',
  'postingEnabled', 'weekdaysOnly', 'queueEnabled', 'biliSource', 'convSource',
  'srcWeather', 'srcNews', 'srcGithub', 'srcBlog', 'srcPlugins', 'srcChat',
  'replyOwnerEnabled', 'replyOwnerMentions', 'replyOwnerTimeline',
  'replyFriendEnabled', 'replyFriendMentions', 'replyFriendTimeline',
  'replyOtherEnabled', 'replyOtherMentions', 'replyOtherTimeline',
]
const NUM_BOUNDS = {
  maxPerDayOwner: [0, 200],
  maxPerDayOthers: [0, 200],
  perThreadHuman: [1, 10],
  perThreadBot: [0, 10],
  timelineProb: [0, 1],
  sinceHours: [1, 168],
  replyMaxChars: [20, 1000],
  retentionDays: [7, 3650],
  pollSec: [15, 600],
  chatSinceHours: [1, 168],
  dailyMin: [0, 50],
  dailyMax: [0, 50],
  minGapMin: [10, 600],
  graceMin: [1, 720],
  queueGapMin: [1, 120],
  queueGapMax: [1, 240],
  lat: [-90, 90],
  lon: [-180, 180],
  replyOwnerMaxPerDay: [0, 200],
  replyOwnerPerThread: [1, 10],
  replyOwnerMinGapMin: [1, 240],
  replyFriendMaxPerDay: [0, 200],
  replyFriendPerThread: [1, 10],
  replyFriendMinGapMin: [1, 240],
  replyOtherMaxPerDay: [0, 200],
  replyOtherPerThread: [1, 10],
  replyOtherMinGapMin: [1, 240],
}
const ENUMS = {
  scope: ['mentions', 'mentions+owner', 'all'],
  notebook: ['local', 'local+mnemon', 'off'],
  replyVisibility: ['public', 'unlisted', 'private'],
}

export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function appendJsonl(path, row) {
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
}

export function normalizeInstance(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s.replace(/\/+$/, '')
}

export function mergeConfig(base, patch) {
  const out = { ...base }
  const src = patch && typeof patch === 'object' ? patch : {}
  for (const k of BOOL_KEYS) {
    if (typeof src[k] === 'boolean') out[k] = src[k]
  }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (typeof src[k] === 'string' && allowed.includes(src[k])) out[k] = src[k]
  }
  for (const [k, [lo, hi]] of Object.entries(NUM_BOUNDS)) {
    if (src[k] === undefined || src[k] === null || src[k] === '') continue
    const v = Number(src[k])
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v))
  }
  for (const k of ['ownerAcct', 'language', 'llmProvider', 'llmModel', 'windowStart', 'windowEnd', 'tz', 'city', 'biliQueueDir', 'chatSessionsDir', 'personaFile', 'personaText', 'marketIndexUrl']) {
    if (typeof src[k] === 'string') out[k] = src[k].trim().slice(0, k === 'personaText' ? 4000 : 500)
  }
  for (const k of ['allowlist', 'blocklist']) {
    if (Array.isArray(src[k])) {
      out[k] = [...new Set(src[k].map((x) => String(x).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))].slice(0, 500)
    } else if (typeof src[k] === 'string') {
      out[k] = [...new Set(src[k].split(/[\s,，]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))].slice(0, 500)
    }
  }
  return out
}

export function loadConfig(dir) {
  const raw = readJson(join(dir, 'config.json'), {})
  return mergeConfig(CONFIG_DEFAULTS, raw)
}

export function saveConfig(dir, cfg) {
  writeJson(join(dir, 'config.json'), cfg)
}

/** 凭证只存这里；不含在任何会被日志打印的对象里 */
export function loadCreds(dir) {
  const c = readJson(join(dir, 'credentials.json'), null)
  if (!c || typeof c !== 'object') return { instance: '', token: '', proxy: '' }
  return {
    instance: normalizeInstance(c.instance),
    token: typeof c.token === 'string' ? c.token : '',
    proxy: typeof c.proxy === 'string' ? c.proxy.trim() : '',
  }
}

export function saveCreds(dir, creds) {
  writeJson(join(dir, 'credentials.json'), {
    instance: normalizeInstance(creds.instance),
    token: String(creds.token || '').trim(),
    proxy: String(creds.proxy || '').trim(),
  })
}

/**
 * 本机第一次装：如果自己家还没有凭证，就从旧 Mastodon 方案那边搬一次。
 * 只搬 instance/token/proxy，不碰别的；搬失败不影响任何事。
 */
export function importLegacyCreds(dir) {
  const own = loadCreds(dir)
  if (own.token) return own
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const legacy = readJson(join(dshHome, 'secrets', 'mastodon.json'), null)
  if (!legacy || typeof legacy !== 'object' || !legacy.token) return own
  const creds = {
    instance: normalizeInstance(legacy.instance),
    token: String(legacy.token),
    proxy: String(legacy.proxy || '').trim(),
  }
  saveCreds(dir, creds)
  return creds
}

export function loadState(dir) {
  const s = readJson(join(dir, 'state.json'), {})
  return s && typeof s === 'object' ? s : {}
}

export function saveState(dir, state) {
  writeJson(join(dir, 'state.json'), state)
}

export function logLine(dir, msg) {
  const line = `${new Date().toISOString()}  ${msg}\n`
  try { appendFileSync(join(dir, 'mastodon-toot.log'), line, 'utf8') } catch { /* 日志写不进去不致命 */ }
}

export function tailLog(dir, lines = 40) {
  const p = join(dir, 'mastodon-toot.log')
  try {
    const st = statSync(p)
    const size = Math.min(st.size, 64 * 1024)
    const buf = readFileSync(p)
    const text = buf.subarray(Math.max(0, buf.length - size)).toString('utf8')
    return text.split(/\r?\n/).filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

export function notebookStats(dir) {
  const nb = join(dir, 'notebook')
  let interactions = 0
  let people = 0
  try {
    const text = readFileSync(join(nb, 'interactions.jsonl'), 'utf8')
    interactions = text.split(/\r?\n/).filter(Boolean).length
  } catch { /* 还没有 */ }
  const p = readJson(join(nb, 'people.json'), null)
  if (p && typeof p === 'object') people = Object.keys(p).length
  return { interactions, people }
}

export function redactCreds(creds) {
  const t = creds.token || ''
  return {
    instance: creds.instance,
    proxy: creds.proxy,
    hasToken: !!t,
    tokenTail: t ? t.slice(-4) : '',
  }
}
