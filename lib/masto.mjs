/**
 * lib/masto.mjs —— 只做一件事：把 Mastodon 的 REST 调用讲清楚
 * - 不用第三方依赖；直连走 fetch，配了代理就自己开 CONNECT 隧道
 * - 错误统一成 MastoError（带 status 与原 body），上层好判断 401/429
 * - token 从不进错误文本
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const UA = 'dsh-mastodon-toot/0.3.2 (+https://github.com/meowdan/dsh-mastodon-toot)'

export class MastoError extends Error {
  constructor(message, status = 0, body = null) {
    super(message)
    this.name = 'MastoError'
    this.status = status
    this.body = body
  }
}

export function normalizeBase(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s.replace(/\/+$/, '')
}

function parseBody(text, contentType) {
  const t = String(text || '')
  if (!t) return null
  if (/json/i.test(contentType || '') || /^[\[{]/.test(t.trim())) {
    try { return JSON.parse(t) } catch { /* 不是 JSON 就按文本 */ }
  }
  return t
}

function friendlyNetworkError(e) {
  const code = e?.cause?.code || e?.code || ''
  const map = {
    ENOTFOUND: '域名解析失败：实例地址写对了吗',
    ECONNREFUSED: '连接被拒绝：实例没开或端口不对',
    ETIMEDOUT: '连接超时：检查网络或代理',
    ECONNRESET: '连接被重置：可能是代理/网络拦截',
    CERT_HAS_EXPIRED: '证书过期了',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签证书被拒绝（自建实例可先直连测试）',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整',
    UND_ERR_CONNECT_TIMEOUT: '连接超时：检查网络或代理',
  }
  return map[code] || `网络错误：${e?.message || e}`
}

function errorText(status, data) {
  const detail = data && typeof data === 'object' ? (data.error || data.error_description || '') : ''
  const hints = {
    401: '令牌无效或已过期，去设置页重新填 token',
    403: '令牌权限不够（需要 write:statuses / read:notifications）',
    404: '接口不存在：实例地址可能不是 Mastodon（或版本太老）',
    429: '被实例限流了，等一会儿再试',
    422: '请求内容不合法',
    500: '实例内部错误',
    503: '实例暂时不可用',
  }
  return `${hints[status] || '请求失败'}（HTTP ${status}${detail ? '：' + detail : ''}）`
}

async function direct(url, { method, headers, body, timeoutMs }) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new MastoError(friendlyNetworkError(e), 0, null)
  }
  const text = await res.text()
  const data = parseBody(text, res.headers.get('content-type'))
  if (!res.ok) throw new MastoError(errorText(res.status, data), res.status, data)
  return { data, headers: res.headers }
}

function connectTunnel(proxy, host, port, timeoutMs) {
  const p = new URL(proxy)
  const auth = p.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
    : ''
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...(auth ? { 'proxy-authorization': auth } : {}) },
    })
    const timer = setTimeout(() => req.destroy(new Error('代理连接超时')), timeoutMs)
    req.on('connect', (res, socket) => {
      clearTimeout(timer)
      if (res.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new MastoError(`代理拒绝 CONNECT（HTTP ${res.statusCode}）`, 0, null)) }
    })
    req.on('error', (e) => { clearTimeout(timer); reject(new MastoError(friendlyNetworkError(e), 0, null)) })
    req.end()
  })
}

async function viaProxy(url, { method, headers, body, timeoutMs, proxy }) {
  const u = new URL(url)
  const port = Number(u.port) || 443
  const socket = await connectTunnel(proxy, u.hostname, port, timeoutMs)
  socket.on('error', () => { /* 交给 request 的 error */ })
  return await new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname,
      port,
      method,
      path: u.pathname + u.search,
      headers,
      agent: false,
      createConnection: () => tls.connect({ socket, servername: u.hostname }),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const data = parseBody(text, res.headers['content-type'])
        if (res.statusCode >= 400) reject(new MastoError(errorText(res.statusCode, data), res.statusCode, data))
        else resolve({ data, headers: res.headers })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new MastoError('请求超时', 0, null)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 统一入口：creds = {instance, token, proxy} */
export async function api(creds, path, opts = {}) {
  const base = normalizeBase(creds.instance)
  if (!base) throw new MastoError('还没填实例地址', 0, null)
  const url = base + (path.startsWith('/') ? path : '/' + path)
  const method = opts.method || 'GET'
  const headers = { accept: 'application/json', 'user-agent': UA, ...(opts.headers || {}) }
  if (creds.token) headers.authorization = 'Bearer ' + creds.token
  let body
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 15000)
  const proxy = String(creds.proxy || '').trim()
  if (proxy && url.startsWith('https:')) {
    return viaProxy(url, { method, headers, body, timeoutMs, proxy })
  }
  try {
    return await direct(url, { method, headers, body, timeoutMs })
  } catch (e) {
    if (proxy && e.status === 0) {
      // 直连失败、又配了代理：再走一次隧道
      return viaProxy(url, { method, headers, body, timeoutMs, proxy })
    }
    throw e
  }
}

export async function verify(creds) {
  const { data } = await api(creds, '/api/v1/accounts/verify_credentials')
  return data
}

export async function instanceInfo(creds) {
  try {
    const { data } = await api(creds, '/api/v2/instance')
    return normalizeInstance(data)
  } catch (e) {
    if (e.status && e.status !== 404) throw e
    const { data } = await api(creds, '/api/v1/instance')
    return normalizeInstance(data)
  }
}

function normalizeInstance(d) {
  if (!d || typeof d !== 'object') return null
  const cfg = d.configuration || {}
  const st = cfg.statuses || {}
  return {
    uri: d.uri || d.domain || '',
    title: d.title || d.domain || '',
    version: d.version || '',
    maxChars: Number(st.max_characters) || 500,
    maxMedia: Number(st.max_media_attachments) || 4,
  }
}

export function slimAccount(a) {
  if (!a || typeof a !== 'object') return null
  return {
    id: String(a.id || ''),
    acct: String(a.acct || ''),
    username: String(a.username || ''),
    displayName: String(a.display_name || ''),
    avatar: String(a.avatar_static || a.avatar || ''),
    followers: Number(a.followers_count) || 0,
    statuses: Number(a.statuses_count) || 0,
  }
}
