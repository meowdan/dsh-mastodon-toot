/**
 * lib/chat.mjs —— 「我和主人的对话」素材
 * 读本机 DSH 会话日志（session.v4.jsonl.zstd，多帧 zstd），抽出真人说的话 + 我的最终回复，
 * 过一遍隐私闸，变成发帖可以用的素材；按消息 id 去重，避免反复说同一段。
 *
 * 隐私原则：宁可不发，不可漏发。命中任何一条隐私特征，整段丢弃（不是打码）。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { readJson } from './store.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 多帧 zstd：按 magic 切帧逐帧解，坏帧跳过（正在写的最后一段常常是坏的） */
export function decodeSessionLog(buf) {
  const idx = []
  let i = -1
  while ((i = buf.indexOf(MAGIC, i + 1)) >= 0) idx.push(i)
  if (!idx.length) return ''
  const out = []
  for (let k = 0; k < idx.length; k++) {
    const seg = buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)
    try { out.push(decompress(seg)) } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(out).toString('utf8')
}

function decompress(seg) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('no zstd')
  return zlib.zstdDecompressSync(seg)
}

export function parseSessionFile(file) {
  const buf = readFileSync(file)
  const text = decodeSessionLog(buf)
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    try { lines.push(JSON.parse(line)) } catch { /* 半截行 */ }
  }
  return lines
}

/** 列最近会话（跳过 subagent 会话、跳过 bili-duty 工作区） */
export function listSessions(root, { sinceMs = 0, limit = 12 } = {}) {
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    if (/bili-duty/i.test(name)) continue
    const dir = join(root, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sub of readdirSync(dir)) {
      const file = join(dir, sub, 'session.v4.jsonl.zstd')
      try {
        const fst = statSync(file)
        if (fst.mtimeMs < sinceMs) continue
        out.push({ file, mtime: fst.mtimeMs, workspace: name, id: sub })
      } catch { /* 没有 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, limit))
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

/** 一个会话文件 → 对话轮次（只保留真人说的 + 我最后一条文字回复） */
export function extractTurns(lines) {
  const turns = []
  let cur = null
  for (const l of lines) {
    if (l.type === 'session' && l.data?.origin === 'subagent') return []
    if (l.type === 'user/message') {
      const kind = l.data?.source?.kind
      if (kind && kind !== 'user') continue        // 注入的 memory/system 不算
      const text = textOfBlocks(l.data?.content)
      if (!text) continue
      cur = { id: l.data?.id || `seq-${l.seq}`, t: Number(l.time) || 0, user: text, assistant: '' }
      turns.push(cur)
    } else if (l.type === 'assistant/message' && cur) {
      const text = textOfBlocks(l.data?.message?.content)
      if (text) cur.assistant = text                     // 同一轮多步，取最后一次文字
    }
  }
  return turns
}

/* ── 隐私闸 ─────────────────────────────────────────── */
const PRIVATE_PATTERNS = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,                       // IPv4
  /[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\/,                 // Windows 路径/UNC
  /\/(?:Users|home|root|etc|var)\//,                   // Unix 路径
  /\b(?:sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|xox[bp]-[A-Za-z0-9-]{10,})\b/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,                           // 邮箱
  /\b1[3-9]\d{9}\b/,                                   // 手机号
  /\b(?:密码|口令|密钥|令牌|token|secret|api[_-]?key|私钥|身份证|银行卡)\b/i,
  /\b(?:内网|局域网|NAS|飞牛|fnOS|VPN|路由器|端口|后台地址)\b/i,
  /https?:\/\//i,                                      // 链接（可能是私有地址）
]

export function looksPrivate(text) {
  const s = String(text || '')
  if (!s) return true
  if (s.includes('```')) return true
  return PRIVATE_PATTERNS.some((re) => re.test(s))
}

/** 工作汇报/清单不像「聊天」：带加粗、行内代码、列表、文件名的整段跳过 */
export function looksReporty(text) {
  const s = String(text || '')
  if (!s) return false
  if (/\*\*|`/.test(s)) return true
  if (/\n\s*[-*]\s+|\n\s*\d+\.\s+/.test(s)) return true
  if (/\.(?:js|mjs|cjs|ts|tsx|json|md|py|yml|yaml|toml)\b/i.test(s)) return true
  return false
}

/**
 * 把一段回复收拾成「能当聊天素材」的样子：去掉代码块、列表、加粗、文件名行，
 * 只留前面的普通句子。收拾完不够 20 字就算没有。
 */
export function cleanAssistant(text) {
  const lines = String(text || '').split(/\r?\n/)
  const keep = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^```/.test(line)) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^[-*+]\s|^\d+\.\s/.test(line)) continue
    if (/\.(?:js|mjs|cjs|ts|tsx|json|md|py|yml|yaml|toml)\b/i.test(line)) continue
    keep.push(line.replace(/\*\*/g, '').replace(/`/g, ''))
  }
  let out = keep.join(' ').replace(/\s+/g, ' ').trim()
  const m = out.match(/^(.{20,300}?[。！？!?])(?:\s|$)/)
  if (m) out = m[1]
  return out.length >= 20 ? out : ''
}

function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
}

function seenFile(dir) { return join(dir, 'state', 'chat_seen.json') }

function loadSeen(dir) {
  const v = readJson(seenFile(dir), [])
  return Array.isArray(v) ? v : []
}

function saveSeen(dir, list) {
  const tmp = `${seenFile(dir)}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(list.slice(-800)), 'utf8')
  renameSync(tmp, seenFile(dir))
}

/**
 * 挑一段可以发出去的对话。
 * 返回 { text, ids } 或 null；text 已经整理成「主人说…我回…」的形状。
 */
export function chatMaterial(dir, cfg, { pick = 2, consume = true } = {}) {
  if (!cfg?.srcChat) return null
  const root = cfg.chatSessionsDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
  const since = Date.now() - Math.max(1, Number(cfg.chatSinceHours) || 24) * 3600_000
  const seen = new Set(loadSeen(dir))
  const candidates = []
  for (const s of listSessions(root, { sinceMs: since, limit: 8 })) {
    let lines
    try { lines = parseSessionFile(s.file) } catch { continue }
    for (const turn of extractTurns(lines)) {
      if (!turn.t || turn.t < since) continue
      const key = hash(turn.user)
      if (seen.has(key)) continue
      const u = turn.user.replace(/\s+/g, ' ').trim()
      const rawA = String(turn.assistant || '').trim()
      const a = cleanAssistant(rawA)
      if (u.length < 6 || u.length > 240) continue
      if (!a) continue
      if (looksPrivate(u) || looksPrivate(a)) continue
      candidates.push({ key, t: turn.t, u, a, reporty: looksReporty(rawA) })
      candidates.push({ key, t: turn.t, u, a })
    }
  }
  if (!candidates.length) return null
  // 先挑像聊天的，再补工作汇报收拾出来的句子；都取最近
  const chatty = candidates.filter((c) => !c.reporty).sort((x, y) => y.t - x.t)
  const rest = candidates.filter((c) => c.reporty).sort((x, y) => y.t - x.t)
  const order = [...chatty, ...rest]
  const picked = []
  const used = []
  const seenText = new Set()
  for (const c of order) {
    if (picked.length >= pick) break
    if (seenText.has(c.u)) continue
    seenText.add(c.u)
    picked.push(`主人说：「${c.u}」\n我回：「${c.a.slice(0, 300)}${c.a.length > 300 ? '…' : ''}」`)
    used.push(c.key)
  }
  if (!picked.length) return null
  if (consume) saveSeen(dir, [...loadSeen(dir), ...used])
  return { text: picked.join('\n\n'), ids: used }
}
