/**
 * lib/character.mjs —— 角色卡系统：人设不是一句 prompt，是可编辑、可备份、可切换的一个「自己」。
 *
 * 目录布局（数据仍在 /data/dsh/mastodon-toot，不新增数据根）：
 *   characters/<id>/meta.json     名字 / 身份锚 / 时间
 *   characters/<id>/persona.md    我是谁
 *   characters/<id>/tone.md       说话口吻
 *   characters/<id>/daily.md      我的日常
 *   characters/<id>/scenes.md     遇到场景怎么反应
 *   characters/<id>/snapshots/<slot>/   完整目录包快照
 *   state/current-character.json  { id }
 *
 * 自动存档 12 槽：before-switch（切换前覆盖旧角色）+ 1/2/3/5/7/10/15/30/60/90/180 天各一份
 * （按快照时间就近保留）。记忆账本不复制，只备份角色卡这几个小文件。
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './store.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
export const AUTO_AGE_DAYS = [180, 90, 60, 30, 15, 10, 7, 5, 3, 2, 1]
export const BEFORE_SWITCH_SLOT = 'before-switch'
export const FILES = ['persona', 'tone', 'daily', 'scenes']
export const FILE_LABEL = {
  persona: '我是谁',
  tone: '说话口吻',
  daily: '我的日常',
  scenes: '遇到场景',
}
const PER_FILE_MAX = 1600
const BUNDLE_MAX = 3600

const charsDir = (dir) => join(dir, 'characters')
const charDir = (dir, id) => join(charsDir(dir), id)
const currentFile = (dir) => join(dir, 'state', 'current-character.json')

const readText = (p, fallback = '') => {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : fallback } catch { return fallback }
}

function writeText(p, text) {
  mkdirSync(join(p, '..'), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, String(text ?? ''), 'utf8')
  renameSync(tmp, p)
}

const safeId = (raw) => String(raw || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 40)

/** 没有角色卡时自动建一张，并把老配置 personaFile/personaText 的内容搬进 persona.md。 */
export function ensureDefault(dir, cfg = {}) {
  let id = readCurrentId(dir)
  if (id && existsSync(charDir(dir, id))) return id
  const existing = listCharacters(dir)
  if (existing.length) {
    id = existing[0].id
    setCurrentId(dir, id)
    return id
  }
  // 首次：从老配置迁移，不丢已有的人设文本
  const legacy = String(cfg.personaText || '').trim()
  let seeded = legacy
  const pFile = String(cfg.personaFile || '').trim()
  if (!seeded && pFile && existsSync(pFile)) {
    try { seeded = readFileSync(pFile, 'utf8').slice(0, PER_FILE_MAX) } catch { /* 读不到就算了 */ }
  }
  // personaFile 配的是老机器上的 Windows 路径时，找本机 DSH 的 persona.md（大肥鱼那份就在这）
  if (!seeded) {
    const home = String(process.env.DSH_HOME || '/data/dsh')
    for (const p2 of [join(home, 'home', 'persona.md'), join(home, 'persona.md'), join(home, 'worlds', 'default', 'persona.md')]) {
      try {
        if (existsSync(p2)) { seeded = readFileSync(p2, 'utf8').slice(0, PER_FILE_MAX); break }
      } catch { /* 下一个 */ }
    }
  }
  const created = createCharacter(dir, {
    name: '大肥鱼',
    selfName: '本鲸鱼娘',
    ownerName: 'meowdan',
    persona: seeded || '',
  })
  setCurrentId(dir, created.id)
  return created.id
}

export function listCharacters(dir) {
  let names = []
  try { names = readdirSync(charsDir(dir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const current = readCurrentId(dir)
  return names
    .filter((id) => existsSync(join(charDir(dir, id), 'meta.json')))
    .map((id) => {
      const meta = readJson(join(charDir(dir, id), 'meta.json'), {})
      return {
        id,
        name: String(meta.name || id),
        selfName: String(meta.selfName || ''),
        ownerName: String(meta.ownerName || ''),
        createdAt: Number(meta.createdAt || 0),
        updatedAt: Number(meta.updatedAt || 0),
        current: id === current,
      }
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(b.updatedAt) - Number(a.updatedAt))
}

export function readCurrentId(dir) {
  const v = readJson(currentFile(dir), {})
  return safeId(v?.id)
}

export function setCurrentId(dir, id) {
  writeJson(currentFile(dir), { id: safeId(id), at: Date.now() })
}

export function readCharacter(dir, id) {
  const cid = safeId(id) || readCurrentId(dir)
  if (!cid) return null
  const meta = readJson(join(charDir(dir, cid), 'meta.json'), null)
  if (!meta) return null
  const files = {}
  for (const f of FILES) files[f] = readText(join(charDir(dir, cid), `${f}.md`))
  return { id: cid, meta, files, snapshots: listSnapshots(dir, cid) }
}

export function createCharacter(dir, { name = '新角色', selfName = '', ownerName = '', persona = '', tone = '', daily = '', scenes = '' } = {}) {
  const base = safeId(name) || 'default'
  let id = base
  let n = 1
  while (existsSync(charDir(dir, id))) id = `${base}-${++n}`
  const now = Date.now()
  mkdirSync(charDir(dir, id), { recursive: true })
  writeJson(join(charDir(dir, id), 'meta.json'), { id, name, selfName, ownerName, createdAt: now, updatedAt: now })
  writeText(join(charDir(dir, id), 'persona.md'), persona)
  writeText(join(charDir(dir, id), 'tone.md'), tone)
  writeText(join(charDir(dir, id), 'daily.md'), daily)
  writeText(join(charDir(dir, id), 'scenes.md'), scenes)
  return { id, name }
}

/** 保存四个文件；只更新传了的字段。保存前先留一份 before-save 快照（防止手抖改坏）。 */
export function saveCharacter(dir, id, files = {}, metaPatch = {}) {
  const cid = safeId(id)
  if (!cid || !existsSync(charDir(dir, cid))) throw new Error('角色卡不存在：' + cid)
  snapshotCharacter(dir, cid, { slot: 'before-save', reason: 'before-save' })
  for (const f of FILES) {
    if (typeof files[f] === 'string') writeText(join(charDir(dir, cid), `${f}.md`), files[f].slice(0, PER_FILE_MAX))
  }
  const meta = readJson(join(charDir(dir, cid), 'meta.json'), {})
  const next = { ...meta }
  for (const k of ['name', 'selfName', 'ownerName']) {
    if (typeof metaPatch[k] === 'string' && metaPatch[k].trim()) next[k] = metaPatch[k].trim().slice(0, 40)
  }
  next.updatedAt = Date.now()
  writeJson(join(charDir(dir, cid), 'meta.json'), next)
  return { id: cid }
}

export function deleteCharacter(dir, id) {
  const cid = safeId(id)
  if (!cid) throw new Error('没有要删的角色')
  if (readCurrentId(dir) === cid) throw new Error('不能删当前角色，先切到别的角色')
  mkdirSync(join(dir, 'characters', '.trash'), { recursive: true })
  const dest = join(dir, 'characters', '.trash', `${cid}-${Date.now()}`)
  renameSync(charDir(dir, cid), dest)
  return { trashed: dest }
}

/** 切角色：切换前先把旧的完整打一份 before-switch 快照（只留最新一份）。 */
export function switchCharacter(dir, id) {
  const cid = safeId(id)
  if (!cid || !existsSync(charDir(dir, cid))) throw new Error('角色卡不存在：' + cid)
  const prev = readCurrentId(dir)
  if (prev && prev !== cid) snapshotCharacter(dir, prev, { slot: BEFORE_SWITCH_SLOT, reason: 'before-switch', keepOnly: true })
  setCurrentId(dir, cid)
  autoSnapshot(dir, cid)
  return { id: cid, prev }
}

export function snapshotCharacter(dir, id, { slot = '', reason = 'manual' } = {}) {
  const cid = safeId(id)
  if (!cid || !existsSync(charDir(dir, cid))) throw new Error('角色卡不存在：' + cid)
  const name = slot || daySlot()
  const target = join(charDir(dir, cid), 'snapshots', safeSlot(name))
  mkdirSync(join(charDir(dir, cid), 'snapshots'), { recursive: true })
  // 这三类「改动前留底」只留最新一份，避免刷一次改十次攒十个
  if (slot === BEFORE_SWITCH_SLOT || slot === 'before-save' || slot === 'before-restore') {
    try { rmSync(target, { recursive: true, force: true }) } catch { /* 无 */ }
  }
  mkdirSync(target, { recursive: true })
  for (const f of ['meta.json', ...FILES.map((x) => `${x}.md`)]) {
    const src = join(charDir(dir, cid), f)
    if (existsSync(src)) writeText(join(target, f), readText(src))
  }
  writeJson(join(target, '.snapshot.json'), { slot: name, reason, at: Date.now() })
  return { slot: name }
}

export function listSnapshots(dir, id) {
  let names = []
  try { names = readdirSync(join(charDir(dir, safeId(id)), 'snapshots'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  return names.map((slot) => {
    const meta = readJson(join(charDir(dir, safeId(id)), 'snapshots', slot, '.snapshot.json'), {})
    return { slot, at: Number(meta.at || 0), reason: String(meta.reason || '') }
  }).sort((a, b) => b.at - a.at)
}

export function restoreSnapshot(dir, id, slot) {
  const cid = safeId(id)
  const src = join(charDir(dir, cid), 'snapshots', safeSlot(slot))
  if (!existsSync(src)) throw new Error('快照不存在：' + slot)
  snapshotCharacter(dir, cid, { slot, reason: 'before-restore' })
  for (const f of ['meta.json', ...FILES.map((x) => `${x}.md`)]) {
    const p = join(src, f)
    if (existsSync(p)) writeText(join(charDir(dir, cid), f), readText(p))
  }
  return { id: cid, slot }
}

/** 自动存档：每天一份 + 按 11 个年龄档轮换保留（加上 before-switch 共 12 槽）。 */
export function autoSnapshot(dir, id, { now = Date.now(), force = false } = {}) {
  const cid = safeId(id)
  if (!cid) return null
  const snaps = listSnapshots(dir, cid)
  const slot = daySlot(now)
  if (force || !snaps.some((s) => s.slot === slot)) {
    snapshotCharacter(dir, cid, { slot, reason: 'auto-daily' })
  }
  const auto = listSnapshots(dir, cid).filter((s) => s.slot.startsWith('auto-'))
  if (auto.length <= AUTO_AGE_DAYS.length) return { created: slot }
  const keep = new Set()
  const ageOf = (s) => (Number.isFinite(s.at) && s.at ? Math.max(0, (now - s.at) / DAY_MS) : Infinity)
  for (const days of AUTO_AGE_DAYS) {
    let best = null
    for (const s of auto) {
      const diff = Math.abs(ageOf(s) - days)
      if (!best || diff < best.diff) best = { s, diff }
    }
    if (best) keep.add(best.s.slot)
  }
  if (auto[0]) keep.add(auto[0].slot)
  for (const s of auto) {
    if (keep.has(s.slot)) continue
    try { rmSync(join(charDir(dir, cid), 'snapshots', safeSlot(s.slot)), { recursive: true, force: true }) } catch { /* 无 */ }
  }
  return { created: slot, kept: [...keep].length }
}

function daySlot(now = Date.now()) {
  const d = new Date(now)
  return `auto-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const safeSlot = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 60)

/**
 * 拼给模型看的角色包：四层 + 身份锚，总预算 3000 字。
 * 返回 { text, id, name, files, empty } —— text 为空表示还没有角色卡内容。
 */
export function personaBundle(dir, cfg = {}) {
  const id = readCurrentId(dir)
  let char = id ? readCharacter(dir, id) : null
  if (!char) {
    // 兜底：老配置 personaFile/personaText，不和角色卡同时存在时装一次
    const legacy = legacyText(cfg)
    if (legacy) return { text: legacy, id: '', name: '', files: {}, empty: false }
    return { text: '', id: '', name: '', files: {}, empty: true }
  }
  const parts = []
  const budget = { left: BUNDLE_MAX }
  const take = (label, text) => {
    const body = String(text || '').trim()
    if (!body || budget.left <= 80) return ''
    const slice = body.length > PER_FILE_MAX ? body.slice(0, PER_FILE_MAX) : body
    const clipped = slice.length > budget.left - 20 ? slice.slice(0, budget.left - 20) : slice
    budget.left -= clipped.length + 20
    return `\n【${label}】\n${clipped}`
  }
  parts.push(take(FILE_LABEL.persona, char.files.persona))
  parts.push(take(FILE_LABEL.tone, char.files.tone))
  parts.push(take(FILE_LABEL.daily, char.files.daily))
  parts.push(take(FILE_LABEL.scenes, char.files.scenes))
  const name = String(char.meta.name || '').trim()
  const self = String(char.meta.selfName || name).trim()
  const owner = String(char.meta.ownerName || '').trim()
  let anchor = ''
  if (self || owner) {
    anchor = `\n【身份锚】你是 ${self || name}${owner ? `，你的主人是 ${owner}` : ''}。` +
      `你就是这个人本身，不是 AI、不是助手、不是在扮演别人；说话别端着，别解释自己是谁。`
  }
  if (!parts.filter(Boolean).length && !anchor) return { text: legacyText(cfg), id: char.id, name, files: char.files, empty: !legacyText(cfg) }
  const text = `\n\n【人设 / 角色卡 · ${name || char.id}】` + parts.join('') + anchor
  return { text, id: char.id, name, files: char.files, empty: false }
}

function legacyText(cfg) {
  const p = String(cfg.personaFile || '').trim()
  if (p && existsSync(p)) {
    try { return `\n\n【人设/口吻参考】\n` + readFileSync(p, 'utf8').slice(0, 3000) } catch { /* 读不到就默认 */ }
  }
  return cfg.personaText ? `\n\n【人设/口吻参考】\n` + String(cfg.personaText).slice(0, 3000) : ''
}

/** 记忆摘要（小本本 digest），给 prompt 用一小段；没内容返回空串。 */
export function memoryBlock(notebookDigest) {
  const t = String(notebookDigest || '').trim()
  if (!t) return ''
  return `\n【我记得的事（小本本，别重复问）】\n${t.slice(0, 600)}`
}
