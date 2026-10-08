/**
 * 后台入口 URL 归一化。
 *
 * 必须在 createWebHashHistory() 之前执行：vue-router 用 location.pathname + location.search
 * 作为 base，并在创建的那一刻一次性快照初始路由；此后任何 history.replaceState() 都不会派发
 * popstate，Router 不会跟进。结果是"地址栏写着后台、渲染的却是看板"，看板在私有站点拿到 401 后
 * 又按 pathname 判定"已在后台"而 reload，形成刷新循环。
 *
 * 归一化后形成不变量：只要 pathname 是 /admin，hash 必定是 #/admin（可带 query）。
 * 于是 /admin 下只会渲染后台，不会再出现"地址栏写着后台、渲染的却是看板"。
 *
 * 兼容说明：第三方主题的入口按 theme-develop.md 的历史约定写作 /admin#admin，
 * 该旧式同样解析为后台路由，这里接受它并把地址栏收敛到 #/admin 形式。
 */

const ADMIN_PATH = '/admin'
const ADMIN_HASH = '#/admin'
// 后台 hash 的新旧两种写法，query 原样保留。
// $ 边界是必需的：否则 #/administrator、#adminx 这类前缀误匹配会拼出不存在的路由，渲染成空白页
const ADMIN_HASH_QUERY = /^#\/?admin(\?.*)?$/

// 私有站跳转、主题入口共用的标准后台地址
export const ADMIN_ENTRY_URL = `${ADMIN_PATH}${ADMIN_HASH}`

export const isAdminPath = (pathname) => {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '')
  return path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`)
}

/**
 * 计算后台入口需要归一化成的 URL。
 * @returns {string|null} 需要改写时返回目标 URL，已经处于标准形式时返回 null
 */
export const resolveAdminEntryUrl = ({ pathname = '', search = '', hash = '' } = {}) => {
  if (!isAdminPath(pathname)) return null

  // 查询参数整体搬进 hash：hash history 会把 location.search 并入 base，
  // 而它之后只用 '#'+path 写地址栏，留在 search 里的 ?foo=1 永远清不掉。
  // 无 hash、以及 pathname 是 /admin 时的其它 hash 都留空后缀，一律按后台入口处理：
  // 看板只有域名根路径入口（/#/），详情页只有 /#/server/:id，都不挂在 /admin 下
  const suffix = ADMIN_HASH_QUERY.exec(hash)?.[1] || search
  const target = `${ADMIN_PATH}${ADMIN_HASH}${suffix}`
  return target === `${pathname}${search}${hash}` ? null : target
}

export const normalizeAdminEntryUrl = () => {
  if (typeof window === 'undefined') return
  const { pathname, search, hash } = window.location
  const target = resolveAdminEntryUrl({ pathname, search, hash })
  if (!target) return
  // state 传 null：随后创建的 vue-router 会重建一份与 URL 一致的 history.state
  window.history.replaceState(null, '', target)
}
