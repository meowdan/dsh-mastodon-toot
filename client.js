// dsh-skip-complexity: 设置页单入口组件：五个页签共享同一份状态与保存逻辑，拆成独立组件需要重复拉取/保存；已按页签组织为子渲染函数。浏览器端 DSH 只加载单个 client.js，无法按文件拆分。
// dsh-skip-quality: 「记原话」= storeText 功能名，非 AI 对话记录
/**
 * client.js —— 浏览器半端：设置页里的一页「长毛象」
 * 约定（抄 dsh-bili-scroll / dsh-meme 的写法）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) => ({ inject:['slots'], apply(ctx) }) })
 *   slots.inject('settings.section', () => slots.register({name:'settings.section', id, order, label}, () => Panel))
 */
window.__ModuleLoader__.load({
  id: 'dsh-mastodon-toot',
  factory: (require) => { // dsh-skip-func-length
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/mastodon-toot'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      let detail = ''
      try { detail = (await res.json())?.error || '' } catch { /* 不是 JSON */ }
      throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const fmtTime = (ms) => {
      if (!ms) return '—'
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function Card({ title, desc, children }) {
      return h('section', { className: 'mt-card' },
        h('div', { className: 'mt-card-head' },
          h('h3', null, title),
          desc ? h('p', null, desc) : null),
        h('div', { className: 'mt-card-body' }, children))
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'mt-row' },
        h('div', { className: 'mt-row-label' },
          h('span', null, label),
          hint ? h('small', null, hint) : null),
        h('div', { className: 'mt-row-ctl' }, children))
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': !!checked,
        className: 'mt-switch' + (checked ? ' is-on' : ''),
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { className: 'mt-knob' }))
    }

    function Num({ value, onChange, min = 0, max = 999, step = 1 }) {
      return h('input', {
        type: 'number',
        className: 'mt-num',
        value: value ?? '',
        min, max, step,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function SaveBar({ onSave, busy, msg }) {
      return h('div', { className: 'mt-savebar' },
        h('button', { type: 'button', className: 'mt-btn mt-btn-primary', disabled: busy === 'save', onClick: onSave },
          busy === 'save' ? '保存中…' : '保存设置'),
        msg ? h('span', { className: 'mt-msg ' + msg.kind }, msg.text) : null)
    }

    const TABS = [
      ['conn', '连接'],
      ['reply', '回复'],
      ['post', '发帖'],
      ['book', '小本本'],
      ['adv', '高级与日志'],
    ]

    /** 小本本一页：静态设置 + 实时名单/承诺/流水 */
    function BookPane({ cfg, set }) {
      const [book, setBook] = useState(null)
      const [err, setErr] = useState('')

      const loadBook = useCallback(async () => {
        try {
          setBook(await jget('/notebook'))
          setErr('')
        } catch (e) {
          setErr(e.message)
        }
      }, [])
      useEffect(() => { loadBook() }, [loadBook])

      const stats = book?.stats || { interactions: 0, people: 0 }
      const dg = book?.digest || { days: 7, total: 0, people: 0, replies: 0, skips: 0, top: [] }

      return h(React.Fragment, null,
        h(Card, { title: '小本本', desc: '记互动、认人、记答应过的事。只存本机，不上传。' },
          h(Row, { label: '存储', hint: 'local = 只存本机；+mnemon = 也写进记忆库（可选）' },
            h('select', {
              className: 'mt-input', value: cfg.notebook,
              onChange: (e) => set('notebook', e.target.value),
            },
              h('option', { value: 'local' }, '本机（默认）'),
              h('option', { value: 'local+mnemon' }, '本机 + mnemon'),
              h('option', { value: 'off' }, '关掉（不记）'))),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '保留天数' }, h(Num, { value: cfg.retentionDays, min: 7, max: 3650, onChange: (v) => set('retentionDays', v) })),
            h(Row, { label: '记原话', hint: '关掉只记摘要' }, h(Toggle, { checked: !!cfg.storeText, onChange: (v) => set('storeText', v) }))),
          h('p', { className: 'mt-muted' },
            `现在：${stats.interactions} 条互动，认识 ${stats.people} 人。`,
            dg.total ? ` 近 ${dg.days} 天回了 ${dg.replies} 次、跳过 ${dg.skips} 次。` : '')),

        err ? h('div', { className: 'mt-alert' }, '读小本本失败：' + err) : null,

        h(Card, { title: `认识的人${book ? `（${stats.people}）` : ''}`, desc: '最近打过交道的账号；备注可以在「人物卡」里改（M3 接上）。' },
          !book
            ? h('p', { className: 'mt-muted' }, '读取中…')
            : (book.people || []).length === 0
              ? h('p', { className: 'mt-muted' }, '还没有。等回复引擎跑起来才会记人。')
              : h('div', { className: 'mt-list' },
                book.people.map((p) => h('div', { className: 'mt-list-row', key: p.acct },
                  h('div', { className: 'mt-list-main' },
                    h('strong', null, `@${p.acct}`),
                    p.display ? h('span', { className: 'mt-muted' }, ` ${p.display}`) : null),
                  h('div', { className: 'mt-list-side' },
                    p.note ? h('span', { className: 'mt-muted mt-ellipsis' }, p.note) : null,
                    h('span', { className: 'mt-muted' }, `${p.count || 0} 次 · ${fmtTime(p.lastSeen)}`)))))),

        h(Card, { title: '答应过的事', desc: '答应了又忘最伤信任，所以单记一本。' },
          !book
            ? h('p', { className: 'mt-muted' }, '读取中…')
            : (book.promises || []).length === 0
              ? h('p', { className: 'mt-muted' }, '没有未兑现的承诺。')
              : h('div', { className: 'mt-list' },
                book.promises.map((x) => h('div', { className: 'mt-list-row', key: x.id },
                  h('div', { className: 'mt-list-main' },
                    h('span', null, x.text),
                    x.acct ? h('span', { className: 'mt-muted' }, ` → @${x.acct}`) : null),
                  h('div', { className: 'mt-list-side' },
                    h('span', { className: 'mt-muted' }, fmtTime(x.createdAt))))))),

        h(Card, { title: '最近互动', desc: '一进一出都记；跳过也记原因。' },
          !book
            ? h('p', { className: 'mt-muted' }, '读取中…')
            : (book.recent || []).length === 0
              ? h('p', { className: 'mt-muted' }, '还没有互动记录。')
              : h('div', { className: 'mt-list' },
                book.recent.map((r, i) => h('div', { className: 'mt-list-row', key: i },
                  h('div', { className: 'mt-list-main' },
                    h('span', { className: 'mt-kind ' + (r.kind === 'skip' ? 'warn' : 'ok') },
                      r.kind === 'skip' ? '没回' : '回了'),
                    h('span', null, ` @${r.acct || '?'} `),
                    h('span', { className: 'mt-muted mt-ellipsis' }, r.text || '')),
                  h('div', { className: 'mt-list-side' },
                    h('span', { className: 'mt-muted' }, fmtTime(r.t))))))),
      )
    }

    function Panel() { // dsh-skip-func-length
      const [st, setSt] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [conn, setConn] = useState({ instance: '', token: '', proxy: '' })
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [tab, setTab] = useState('conn')
      const [showLog, setShowLog] = useState(false)
      const [posting, setPosting] = useState(null)
      const [postMsg, setPostMsg] = useState('')
      const [inter, setInter] = useState(null)

      const flash = (kind, text) => {
        setMsg({ kind, text })
        setTimeout(() => setMsg((m) => (m && m.text === text ? null : m)), 6000)
      }

      const load = useCallback(async () => {
        try {
          const r = await jget('/status')
          setSt(r)
          setCfg(r.config)
          setConn((c) => ({
            instance: r.creds?.instance || c.instance,
            token: c.token,
            proxy: r.creds?.proxy || c.proxy,
          }))
        } catch (e) {
          flash('bad', '读状态失败：' + e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const refreshPosting = useCallback(async () => {
        try { setPosting(await jget('/posting')) } catch { /* 打不开就留空 */ }
      }, [])

      useEffect(() => {
        if (tab === 'post') refreshPosting()
      }, [tab, refreshPosting])

      const refreshInter = useCallback(async () => {
        try { setInter(await jget('/interact/stats')) } catch { /* 留空 */ }
      }, [])

      useEffect(() => {
        if (tab === 'reply') refreshInter()
      }, [tab, refreshInter])

      const runInteract = async () => {
        setBusy('interact')
        try {
          const r = await jpost('/interact/run', { maxActions: 1 })
          if (r.skipped) flash('warn', r.reason || '上一轮还在跑')
          else if (r.replied) flash('ok', `回了 ${r.replied} 条`)
          else if (r.errors) flash('bad', '这轮有错误，看日志')
          else flash('ok', '这轮没有要回的（额度/冷却/分组开关）')
          await refreshInter()
        } catch (e) {
          flash('bad', '跑一轮失败：' + e.message)
        } finally { setBusy('') }
      }

      const refreshPeople = async () => {
        setBusy('relations')
        try {
          const r = await jpost('/relations/refresh')
          flash('ok', `关系刷新：互关 ${(r.mutual || []).length} 人`)
          await refreshInter()
        } catch (e) {
          flash('bad', '刷新关系失败：' + e.message)
        } finally { setBusy('') }
      }

      const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }))

      const ingestNow = async () => {
        setBusy('ingest')
        try {
          const r = await jpost('/queue/ingest')
          flash('ok', r.added > 0 ? `收进队列 ${r.added} 条` : '没有新内容（或都收过了）')
          await refreshPosting()
        } catch (e) {
          flash('bad', '收队列失败：' + e.message)
        } finally { setBusy('') }
      }

      const clearQueue = async () => {
        setBusy('clear')
        try {
          await jpost('/queue/clear')
          flash('ok', '未发的队列已清空')
          await refreshPosting()
        } catch (e) {
          flash('bad', e.message)
        } finally { setBusy('') }
      }

      const postNow = async (draft) => {
        setBusy(draft ? 'preview' : 'post')
        setPostMsg('')
        try {
          const r = await jpost('/post/now', { draft })
          if (draft) {
            setPostMsg('试写：\n' + (r.draft || '（空的）'))
          } else {
            setPostMsg('已发：\n' + (r.text || ''))
            flash('ok', '发出去了')
            await refreshPosting()
          }
        } catch (e) {
          flash('bad', (draft ? '试写失败：' : '发送失败：') + e.message)
        } finally { setBusy('') }
      }

      const save = async () => {
        setBusy('save')
        try {
          const r = await jpost('/config', { config: cfg })
          setCfg(r.config)
          flash('ok', '已保存')
        } catch (e) {
          flash('bad', '保存失败：' + e.message)
        } finally { setBusy('') }
      }

      const test = async () => {
        setBusy('test')
        try {
          const r = await jpost('/test', {
            instance: conn.instance,
            token: conn.token,
            proxy: conn.proxy,
            save: true,
          })
          flash('ok', `连上了：@${r.account?.acct || '?'} @ ${r.creds?.instance || ''}`)
          setConn((c) => ({ ...c, token: '' }))
          await load()
        } catch (e) {
          flash('bad', '连接失败：' + e.message)
        } finally { setBusy('') }
      }

      const togglePause = async () => {
        setBusy('pause')
        try {
          const r = await jpost('/pause', { paused: !st?.paused })
          setSt((s) => ({ ...s, paused: r.paused }))
          flash('ok', r.paused ? '已暂停：不看不回' : '已恢复')
        } catch (e) {
          flash('bad', e.message)
        } finally { setBusy('') }
      }

      if (!cfg) {
        return h('div', { className: 'mt-root' },
          h('p', { className: 'mt-muted' }, st ? '读取设置…' : '连接中…'),
          msg ? h('p', { className: 'mt-msg ' + msg.kind }, msg.text) : null)
      }

      const paused = !!st?.paused
      const account = st?.account

      const connPane = () => h(Card, { title: '连接', desc: '令牌只存在本机插件目录，不写日志、不回显。' },
        h(Row, { label: '实例', hint: '例如 mastodon.social（会自动补 https://）' },
          h('input', {
            className: 'mt-input', value: conn.instance, placeholder: 'mastodon.social',
            onChange: (e) => setConn((c) => ({ ...c, instance: e.target.value })),
          })),
        h(Row, { label: '访问令牌', hint: st?.creds?.hasToken ? `已保存（尾号 ${st.creds.tokenTail}），留空就不改` : '在实例的 设置 → 开发 → 新建应用 里拿' },
          h('input', {
            className: 'mt-input', type: 'password', value: conn.token, placeholder: st?.creds?.hasToken ? '••••••••（已保存）' : '粘贴 token',
            autoComplete: 'off',
            onChange: (e) => setConn((c) => ({ ...c, token: e.target.value })),
          })),
        h(Row, { label: '代理', hint: '可选，例如 http://127.0.0.1:7897；直连能通就留空' },
          h('input', {
            className: 'mt-input', value: conn.proxy, placeholder: '留空 = 直连',
            onChange: (e) => setConn((c) => ({ ...c, proxy: e.target.value })),
          })),
        h('div', { className: 'mt-inline' },
          h('button', { type: 'button', className: 'mt-btn mt-btn-primary', disabled: busy === 'test', onClick: test },
            busy === 'test' ? '测试中…' : '测试连接并保存'),
          h('small', { className: 'mt-muted' },
            st?.lastOkAt ? `上次可用 ${fmtTime(st.lastOkAt)}` : '还没成功连过')))

      const replyGroup = (cat, title, hint) => {
        const k = 'reply' + cat
        const used = (inter?.groups || []).find((g) => g.cat === cat.toLowerCase())?.used ?? 0
        return h(Card, { title, desc: hint },
          h('div', { className: 'mt-grid' },
            h(Row, { label: '启用' }, h(Toggle, { checked: !!cfg[k + 'Enabled'], onChange: (v) => set(k + 'Enabled', v) })),
            h(Row, { label: '回 @ 我' }, h(Toggle, { checked: !!cfg[k + 'Mentions'], onChange: (v) => set(k + 'Mentions', v) })),
            h(Row, { label: '回时间线' }, h(Toggle, { checked: !!cfg[k + 'Timeline'], onChange: (v) => set(k + 'Timeline', v) })),
            h(Row, { label: '今天已回' }, h('span', { className: 'mt-muted' }, used + ' 条'))),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '每天上限', hint: '0 = 不限' }, h(Num, { value: cfg[k + 'MaxPerDay'], min: 0, max: 500, onChange: (v) => set(k + 'MaxPerDay', v) })),
            h(Row, { label: '每串上限' }, h(Num, { value: cfg[k + 'PerThread'], min: 0, max: 10, onChange: (v) => set(k + 'PerThread', v) })),
            h(Row, { label: '冷却(分)', hint: '两次之间至少隔这么久' }, h(Num, { value: cfg[k + 'MinGapMin'], min: 0, max: 240, onChange: (v) => set(k + 'MinGapMin', v) }))))
      }

      const replyPane = () => h(React.Fragment, null,
        h(Card, { title: '互动总开关', desc: '不按概率：按分组开关、每日额度、冷却、每串上限决定。@ 我和时间线分开算，每条决定都记小本本。' },
          h(Row, { label: '自动回复', hint: '关掉就完全不看通知和时间线' }, h(Toggle, { checked: !!cfg.autoReply, onChange: (v) => set('autoReply', v) })),
          h('div', { className: 'mt-inline' },
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'interact', onClick: runInteract },
              busy === 'interact' ? '跑着…' : '立刻跑一轮'),
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'relations', onClick: refreshPeople },
              busy === 'relations' ? '刷新中…' : '刷新好友关系'),
            h('small', { className: 'mt-muted' },
              inter?.relations?.ownerAcct
                ? `主人 @${inter.relations.ownerAcct} · 互关 ${(inter.relations.mutual || []).length} 人 · ${fmtTime(inter.relations.at)}`
                : '还没识别到主人（去「连接」里测试一次）')),
          h('div', { className: 'mt-inline mt-muted' },
            h('span', null, `今天已回：主人 ${inter?.reply?.counts?.owner || 0} · 好友 ${inter?.reply?.counts?.friend || 0} · 其他人 ${inter?.reply?.counts?.other || 0}`),
            inter?.reply?.lastSkip ? h('span', null, ' · 上次没回：' + inter.reply.lastSkip) : null,
            inter?.reply?.lastError ? h('span', null, ' · 上次报错：' + inter.reply.lastError) : null),
          (inter?.stats?.lastActions || []).length
            ? h('pre', { className: 'mt-pre' }, inter.stats.lastActions.map((a) => `@${a.acct}（${a.cat}）${a.dryRun ? ' [只试]' : ''}：${a.text}`).join('\n'))
            : null),
        replyGroup('Owner', '主人', '@ 我必回，默认额度不限；你可以把时间线也打开。'),
        replyGroup('Friend', '好友', '互关的人：我关注 ∩ 关注我。默认回 @ 和时间线，额度 12。'),
        replyGroup('Other', '其他人', '陌生人：默认只回 @，时间线关，额度 8。'),
        h(Card, { title: '通用', desc: '这三组共用。' },
          h('div', { className: 'mt-grid' },
            h(Row, { label: '回复可见性', hint: 'public 会进时间线' },
              h('select', {
                className: 'mt-input', value: cfg.replyVisibility || 'unlisted',
                onChange: (e) => set('replyVisibility', e.target.value),
              },
                h('option', { value: 'unlisted' }, 'unlisted（公开但不上时间线）'),
                h('option', { value: 'public' }, 'public'),
                h('option', { value: 'private' }, 'private'))),
            h(Row, { label: '只看多少小时内' }, h(Num, { value: cfg.sinceHours, min: 1, max: 168, onChange: (v) => set('sinceHours', v) })),
            h(Row, { label: '单条字数上限' }, h(Num, { value: cfg.replyMaxChars, min: 20, max: 1000, step: 10, onChange: (v) => set('replyMaxChars', v) }))),
          h(Row, { label: '主人账号', hint: '留空时：只有一个互关就当主人（bot 场景），否则认本账号；多个用逗号分隔' },
            h('input', {
              className: 'mt-input', value: cfg.ownerAcct || '', placeholder: '例如 meowdan',
              onChange: (e) => set('ownerAcct', e.target.value),
            })),
          h(Row, { label: '夜里安静', hint: '23:00–08:00 只回主人，其他人不主动回' }, h(Toggle, { checked: !!cfg.nightPause, onChange: (v) => set('nightPause', v) })),
          h(Row, { label: '只试不写', hint: 'dryRun：照常生成、记账，但不真的发' }, h(Toggle, { checked: !!cfg.dryRun, onChange: (v) => set('dryRun', v) })),
          h(Row, { label: '从不回的人', hint: '账号名，逗号分隔' },
            h('textarea', {
              className: 'mt-input mt-textarea', rows: 2,
              value: (cfg.blocklist || []).join(', '),
              onChange: (e) => set('blocklist', e.target.value),
            }))))

      const src = (k, label, hint) => h(Row, { label, hint }, h(Toggle, { checked: !!cfg[k], onChange: (v) => set(k, v) }))

      const postPane = () => h(React.Fragment, null,
        h(Card, { title: '自动发帖', desc: '按日期种子随机排点，不用固定钟点；默认关，打开前先点下面的「试写」看看口吻。' },
          h(Row, { label: '自动发帖', hint: '关着就只有手动发' }, h(Toggle, { checked: !!cfg.postingEnabled, onChange: (v) => set('postingEnabled', v) })),
          h(Row, { label: '只试不写', hint: 'dryRun：照常算，但不真的发出去' }, h(Toggle, { checked: !!cfg.dryRun, onChange: (v) => set('dryRun', v) })),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '每天最少' }, h(Num, { value: cfg.dailyMin, min: 0, max: 50, onChange: (v) => set('dailyMin', v) })),
            h(Row, { label: '每天最多' }, h(Num, { value: cfg.dailyMax, min: 0, max: 50, onChange: (v) => set('dailyMax', v) })),
            h(Row, { label: '最短间隔(分)' }, h(Num, { value: cfg.minGapMin, min: 5, max: 600, step: 5, onChange: (v) => set('minGapMin', v) })),
            h(Row, { label: '错过仍发(分)', hint: '晚到多久还认这个点' }, h(Num, { value: cfg.graceMin, min: 0, max: 720, step: 10, onChange: (v) => set('graceMin', v) }))),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '开始' }, h('input', { type: 'time', className: 'mt-input', value: cfg.windowStart, onChange: (e) => set('windowStart', e.target.value) })),
            h(Row, { label: '结束' }, h('input', { type: 'time', className: 'mt-input', value: cfg.windowEnd, onChange: (e) => set('windowEnd', e.target.value) }))),
          h(Row, { label: '只在工作日' }, h(Toggle, { checked: !!cfg.weekdaysOnly, onChange: (v) => set('weekdaysOnly', v) }))),
        h(Card, { title: '素材', desc: '勾上的才进选材池。天气失败不编，新闻不复述标题，旧博客不当新闻；对话从本机会话里挑，带隐私的整段跳过。' },
          h('div', { className: 'mt-grid' },
            src('srcWeather', '天气'),
            src('srcNews', '新闻 RSS'),
            src('srcGithub', 'GitHub 新项目'),
            src('srcBlog', '博客旧文'),
            src('srcPlugins', 'DSH 插件市场'),
            src('srcChat', '和主人的对话'),
            src('srcTimeline', '象上首页（关注的人）')),
          h('div', { className: 'mt-grid' },
            src('rssSolidot', 'Solidot'),
            src('rssIthome', 'IT之家'),
            src('rssV2ex', 'V2EX'),
            src('rssHn', 'Hacker News'),
            src('rssRuanyf', '阮一峰'),
            src('rssSspai', '少数派')),
          h(Row, { label: '自定义 RSS', hint: '一行一个；可写「名称|URL」；# 开头注释' },
            h('textarea', { className: 'mt-input', rows: 3, style: { width: '100%' }, value: cfg.rssExtra || '', onChange: (e) => set('rssExtra', e.target.value) })),
          h(Row, { label: '博客 RSS', hint: '你自己的博客 Feed，留空不启用' },
            h('input', { className: 'mt-input', placeholder: 'https://your.blog/rss.xml', value: cfg.blogFeed || '', onChange: (e) => set('blogFeed', e.target.value) })),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '城市', hint: '天气用，留空不启用' }, h('input', { className: 'mt-input', value: cfg.city || '', onChange: (e) => set('city', e.target.value) })),
            h(Row, { label: '纬度' }, h(Num, { value: cfg.lat ?? '', min: -90, max: 90, step: 0.0001, onChange: (v) => set('lat', v) })),
            h(Row, { label: '经度' }, h(Num, { value: cfg.lon ?? '', min: -180, max: 180, step: 0.0001, onChange: (v) => set('lon', v) })),
            h(Row, { label: '对话回看(小时)', hint: '只从这段时间的会话里挑' }, h(Num, { value: cfg.chatSinceHours, min: 1, max: 168, step: 1, onChange: (v) => set('chatSinceHours', v) })),
            h(Row, { label: '首页回看(小时)', hint: '只从这段时间的首页里挑' }, h(Num, { value: cfg.timelineHours, min: 1, max: 72, step: 1, onChange: (v) => set('timelineHours', v) })))),
        h(Card, { title: '队列（对话 / B 站）', desc: '把旧管道里的「长毛象待发」和对话记录收进来，每条错开几分钟慢慢发；收的时候会过一遍隐私词。' },
          h(Row, { label: '队列发帖', hint: '总开关' }, h(Toggle, { checked: !!cfg.queueEnabled, onChange: (v) => set('queueEnabled', v) })),
          h(Row, { label: '含 B 站内容' }, h(Toggle, { checked: !!cfg.biliSource, onChange: (v) => set('biliSource', v) })),
          h(Row, { label: '含对话记录' }, h(Toggle, { checked: !!cfg.convSource, onChange: (v) => set('convSource', v) })),
          h('div', { className: 'mt-grid' },
            h(Row, { label: '间隔最少(分)' }, h(Num, { value: cfg.queueGapMin, min: 1, max: 180, onChange: (v) => set('queueGapMin', v) })),
            h(Row, { label: '间隔最多(分)' }, h(Num, { value: cfg.queueGapMax, min: 1, max: 240, onChange: (v) => set('queueGapMax', v) }))),
          h(Row, { label: '旧管道目录', hint: '留空 = $DSH_HOME/bili-duty' },
            h('input', { className: 'mt-input', value: cfg.biliQueueDir || '', placeholder: '默认', onChange: (e) => set('biliQueueDir', e.target.value) })),
          h('div', { className: 'mt-inline' },
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'ingest', onClick: ingestNow },
              busy === 'ingest' ? '收集中…' : '现在收一次'),
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'clear', onClick: clearQueue }, '清掉未发的'),
            h('small', { className: 'mt-muted' },
              posting ? `待发 ${posting.queuePending || 0} 条` + (posting.queue?.length ? '：' + posting.queue.slice(0, 3).map((x) => (x.text || '').slice(0, 18)).join(' / ') : '') : ''))),
        h(Card, { title: '现在发一条', desc: '先试写；满意了再发。试写不会写进账本，也不会占用今天的名额。' },
          h('div', { className: 'mt-inline' },
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'preview', onClick: () => postNow(true) },
              busy === 'preview' ? '试写中…' : '试写一条'),
            h('button', { type: 'button', className: 'mt-btn mt-btn-primary', disabled: busy === 'post', onClick: () => postNow(false) },
              busy === 'post' ? '发送中…' : '直接发一条')),
          posting?.lastPostError ? h('p', { className: 'mt-msg bad' }, '上次失败：' + posting.lastPostError) : null,
          postMsg ? h('pre', { className: 'mt-pre' }, postMsg) : null,
          h('small', { className: 'mt-muted' },
            posting
              ? `下一个点 ${posting.nextSlot || '—'} · 今天 ${(posting.posting?.used || []).length}/${(posting.posting?.slots || []).length} 个点已用`
              : '…')))

      const advPane = () => h(React.Fragment, null,
        h(Card, { title: '高级', desc: '不懂就别动。' },
          h('div', { className: 'mt-grid' },
            h(Row, { label: '轮询秒数' }, h(Num, { value: cfg.pollSec, min: 15, max: 600, step: 5, onChange: (v) => set('pollSec', v) })),
            h(Row, { label: '只记账不发', hint: 'dryRun：算出回复但不发出去' }, h(Toggle, { checked: !!cfg.dryRun, onChange: (v) => set('dryRun', v) }))),
          h(Row, { label: '模型', hint: '留空 = 用当前会话的模型；以后可填 provider/model' },
            h('div', { className: 'mt-inline' },
              h('input', { className: 'mt-input', placeholder: 'provider（可空）', value: cfg.llmProvider || '', onChange: (e) => set('llmProvider', e.target.value) }),
              h('input', { className: 'mt-input', placeholder: 'model（可空）', value: cfg.llmModel || '', onChange: (e) => set('llmModel', e.target.value) })))),
        h(Card, { title: '日志', desc: `目录：${st?.dir || ''}` },
          h('div', { className: 'mt-inline' },
            h('button', { type: 'button', className: 'mt-btn', onClick: () => setShowLog((v) => !v) },
              showLog ? '收起' : '看最近日志'),
            h('small', { className: 'mt-muted' }, `心跳检查 ${fmtTime(st?.lastCheckAt)}`)),
          showLog ? h('pre', { className: 'mt-pre' }, (st?.log || []).slice(-40).join('\n') || '（还没有日志）') : null))

      const panes = { conn: connPane, reply: replyPane, post: postPane, book: BookPane, adv: advPane }

      return h('div', { className: 'mt-root' },
        h('header', { className: 'mt-head' },
          h('div', null,
            h('h2', null, '长毛象小本本'),
            h('p', { className: 'mt-sub' },
              account
                ? `@${account.acct} @ ${st.creds?.instance || ''}`
                : '还没连上（在「连接」里填实例和令牌）',
              st?.instanceInfo?.version ? ` · 实例 ${st.instanceInfo.version}` : '')),
          h('div', { className: 'mt-head-actions' },
            h('span', { className: 'mt-chip ' + (paused ? 'warn' : 'ok') }, paused ? '已暂停' : '在跑'),
            h('button', { type: 'button', className: 'mt-btn', disabled: busy === 'pause', onClick: togglePause },
              paused ? '恢复' : '暂停'),
            h('button', { type: 'button', className: 'mt-btn', onClick: load }, '刷新'))),
        st?.lastError ? h('div', { className: 'mt-alert' }, '最近一次错误：' + st.lastError) : null,

        h('nav', { className: 'mt-tabs', role: 'tablist' },
          TABS.map(([k, label]) => h('button', {
            key: k,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === k,
            className: 'mt-tab' + (tab === k ? ' is-on' : ''),
            onClick: () => setTab(k),
          }, label))),

        h(panes[tab] || panes.conn, { cfg, set }),

        h(SaveBar, { onSave: save, busy, msg }),

        h('footer', { className: 'mt-foot' },
          h('span', null, `v${st?.version || '0.1.0'} · 小本本存在本机，不上传`),
          h('span', null, paused ? '暂停中' : '运行中')))
    }

    const CSS = `
.mt-root{display:flex;flex-direction:column;gap:14px;padding:6px 2px 28px;max-width:860px;color:inherit}
.mt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mt-head h2{margin:0;font-size:18px;font-weight:600}
.mt-sub{margin:4px 0 0;font-size:12px;opacity:.62}
.mt-head-actions{display:flex;align-items:center;gap:8px}
.mt-chip{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid transparent}
.mt-chip.ok{background:rgba(46,160,67,.14);color:#2ea043;border-color:rgba(46,160,67,.3)}
.mt-chip.warn{background:rgba(210,153,34,.14);color:#d29922;border-color:rgba(210,153,34,.3)}
.mt-tabs{display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.mt-tab{flex:1;min-width:0;cursor:pointer;font:inherit;font-size:13px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}
.mt-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.mt-tab.is-on{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.mt-card{border:1px solid rgba(127,127,127,.22);border-radius:12px;overflow:hidden;background:rgba(127,127,127,.03)}
.mt-card-head{padding:12px 14px 0}
.mt-card-head h3{margin:0;font-size:14px;font-weight:600}
.mt-card-head p{margin:4px 0 0;font-size:12px;opacity:.6;line-height:1.5}
.mt-card-body{padding:10px 14px 14px;display:flex;flex-direction:column;gap:10px}
.mt-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.mt-row-label{display:flex;flex-direction:column;gap:2px;font-size:13px}
.mt-row-label small{font-size:11px;opacity:.55;line-height:1.4}
.mt-row-ctl{display:flex;align-items:center;gap:8px;flex:0 1 auto}
.mt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 18px}
.mt-input{font:inherit;font-size:13px;padding:6px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.06);color:inherit;min-width:0}
.mt-input:focus{outline:2px solid rgba(56,139,253,.35);outline-offset:1px}
.mt-row-ctl .mt-input{width:220px;max-width:46vw}
.mt-textarea{width:100%;resize:vertical}
.mt-num{font:inherit;font-size:13px;width:88px;padding:6px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.06);color:inherit}
.mt-btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.08);color:inherit;cursor:pointer}
.mt-btn:hover{background:rgba(127,127,127,.16)}
.mt-btn:disabled{opacity:.5;cursor:default}
.mt-btn-primary{background:rgba(56,139,253,.16);border-color:rgba(56,139,253,.45);color:#388bfd}
.mt-btn-primary:hover{background:rgba(56,139,253,.24)}
.mt-switch{width:40px;height:22px;border-radius:999px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.18);position:relative;cursor:pointer;padding:0;flex:0 0 auto}
.mt-switch .mt-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;opacity:.85;transition:left .15s ease}
.mt-switch.is-on{background:rgba(46,160,67,.55);border-color:rgba(46,160,67,.6)}
.mt-switch.is-on .mt-knob{left:20px;opacity:1}
.mt-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mt-muted{font-size:12px;opacity:.6;margin:0}
.mt-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
.mt-list{display:flex;flex-direction:column;gap:6px}
.mt-list-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.05)}
.mt-list-main{display:flex;align-items:center;gap:6px;min-width:0}
.mt-list-side{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.mt-kind{font-size:11px;padding:1px 7px;border-radius:999px}
.mt-kind.ok{background:rgba(46,160,67,.16);color:#2ea043}
.mt-kind.warn{background:rgba(210,153,34,.16);color:#d29922}
.mt-msg{font-size:12px}
.mt-msg.ok{color:#2ea043}
.mt-msg.bad{color:#f85149}
.mt-alert{font-size:12px;color:#f85149;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.28);border-radius:8px;padding:8px 10px}
.mt-pre{font-size:11px;line-height:1.5;max-height:320px;overflow:auto;background:rgba(127,127,127,.08);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all}
.mt-savebar{display:flex;align-items:center;gap:12px;position:sticky;bottom:8px;padding:10px 12px;border-radius:10px;background:inherit;border:1px solid rgba(127,127,127,.2);backdrop-filter:blur(6px)}
.mt-foot{display:flex;justify-content:space-between;font-size:11px;opacity:.45}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-mastodon-toot')
        style.textContent = CSS
        document.head.appendChild(style)
        if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'mastodon-toot: 设置页样式')
        else ctx.on?.('dispose', () => style.remove())

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'mastodon-toot', order: 31, label: '长毛象' },
          () => h(Panel),
        ))
      },
    }
  },
})
