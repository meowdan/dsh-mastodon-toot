// 发布 GitHub Release + 仓库 topic（脚本一次性，不入库）
import fs from 'node:fs'
import path from 'node:path'

const token = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.dsh/git-push/config.json'), 'utf8')).githubToken
const repo = 'meowdan/dsh-mastodon-toot'
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const V = pkg.version
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-mastodon-toot-release' }

async function call(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await r.text()
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const topics = await call(`https://api.github.com/repos/${repo}/topics`, {
  method: 'PUT',
  body: JSON.stringify({ names: ['dsh-plugin', 'mastodon', 'bot'] }),
})
console.log('topics:', topics.names.join(','))

const body = `长毛象小本本 v${V}

把 Mastodon bot 收进 DSH：接入、分组互动（主人 / 好友 / 其他人，不掷骰子）、小本本、发帖管线、队列，全在一个设置页里。

安装（预构建 tarball）：
\`\`\`
dsh plugin --profile desktop add https://github.com/meowdan/dsh-mastodon-toot/releases/download/v${V}/dsh-mastodon-toot-${V}.tgz
\`\`\`

- 需要 DSH >= 0.2.0-rc.2
- 令牌只写入本机 \$DSH_HOME/mastodon-toot/credentials.json
- 默认只试不写（dryRun），确认口吻后再关`

const rel = await call(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: 'v' + V, name: 'v' + V + ' — 长毛象小本本', body, draft: false, prerelease: false }),
})
console.log('release:', rel.html_url)

const tgz = fs.readFileSync('dist/dsh-mastodon-toot-' + V + '.tgz')
const asset = await call(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=dsh-mastodon-toot-${V}.tgz`, {
  method: 'POST',
  headers: { 'content-type': 'application/gzip' },
  body: tgz,
})
console.log('asset:', asset.browser_download_url, asset.size)
