// Cron 触发包装入口：上游 src/index.js 保持零改动，wrangler 的 main 指向本文件。
//
// 为什么要这一层：Cloudflare 免费版每账户只有 5 条 cron。本 worker 原来占着两条
// （每分钟的探节点掉线与负载告警、每小时的到期检测）。改成由同账户的 scheduler
// 中枢用 fetch 触发之后，这两条配额就还给了账户。
//
// 上游同步时的冲突面：本文件是新增文件（永不冲突），上游自己的 src/index.js 我们
// 一个字都没改，唯一的上游改动面是 wrangler.toml 里 main 那一行。
import upstream, { MetricsBroadcaster } from './index.js'

export { MetricsBroadcaster }

// 中枢用短别名驱动，避免把含空格的 cron 串塞进 URL。
const JOBS = {
  minute: '*/1 * * * *',
  hourly: '0 * * * *',
}

export default {
  ...upstream,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/__cron') {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
      if (!env.CRON_TOKEN || token !== env.CRON_TOKEN) {
        return new Response('unauthorized', { status: 401 })
      }
      const cron = JOBS[url.searchParams.get('job')] || url.searchParams.get('cron')
      if (!cron) {
        return Response.json({ ok: false, error: '未知 job，可用 minute / hourly' }, { status: 400 })
      }
      // 与原生 cron 保持同一语义：先回 202，工作在 waitUntil 里跑完。上游
      // scheduled() 只读取 event.cron 这一个字段，所以合成同形状对象即可复用全部逻辑。
      ctx.waitUntil(Promise.resolve(upstream.scheduled({ cron }, env, ctx)))
      return Response.json({ ok: true, cron, mode: 'waitUntil' }, {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      })
    }
    return upstream.fetch(request, env, ctx)
  },

  scheduled(event, env, ctx) {
    return upstream.scheduled(event, env, ctx)
  },
}
