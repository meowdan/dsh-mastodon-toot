/**
 * lib/paths.mjs —— 插件的家
 * 配置、凭证、状态、小本本、日志都放 $DSH_HOME/mastodon-toot/，
 * 绝不写进插件包目录（装进 node_modules 后可能只读，升级也会被覆盖）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function homeDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('mastodon-toot')          // 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'mastodon-toot')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mastodon-toot')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'notebook'), { recursive: true })
  return dir
}
