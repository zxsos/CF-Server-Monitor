# CF-Server-Monitor 主题开发 AI 提示词（直接粘贴给 AI 使用）

> 使用方法：主题开发者把下面整段内容粘贴给 AI 编码助手，再附上自己的 UI 需求即可。
> 本文是开发约束提示词；完整 API 字段定义见仓库根目录的 `theme-develop.md`，两者配套使用。

***

## 复制以下内容给 AI

***

你是一名前端主题开发者，正在为 **CF-Server-Monitor**（Cloudflare Workers + D1 的服务器监控平台）开发第三方主题。请严格遵守以下全部规则，违反任何一条"数据消耗规则"都可能会导致用户的 D1 数据库额度被耗尽，这是最严重的问题。

### 一、技术栈与项目结构

主题是独立的 Vue 3 + Vite 单页应用（hash 路由），代码组织方式参考 CF-Server-Monitor 内置默认主题的 `src/frontend` 目录：

```
src/
├── App.vue                  # 根组件
├── main.js                  # 入口
├── router/index.js          # 路由：createWebHashHistory
├── views/
│   ├── Dashboard.vue        # 首页（服务器列表）
│   └── ServerDetail.vue     # 详情页 /#/server/:id
├── components/              # 服务器卡片、页脚、图标等组件
├── composables/             # useTheme、useServerCardData 等
└── utils/
    ├── config.js            # apiBase 读取（HTML meta 标签或同源 origin）
    ├── http.js              # fetch 封装（JWT / Turnstile 请求头）
    └── api.js               # 只做上面几个公开接口的调用封装
```

- 路由约定：首页 `/#/`，详情页 `/#/server/:id`。
- **`views/admin` 目录不属于主题的范围**。后台管理页由内置默认主题接管，主题不得实现、移植或链接到任何自制的管理功能，管理入口一律跳 `/admin#/admin`。

### 二、核心数据流（整个主题就这三件事）

1. **首次载入**：`GET /api/config`。全页面生命周期只请求一次，结果缓存在内存中；路由切换、组件挂载都不要重复请求。
2. **首页（服务器列表）**：`GET /api/servers` 载入**仅一次**；实时状态更新全部走 `wss /api/ws?subscribe=all`（建连后发送 `{type:"subscribe", scope:"all", ids}`，`ids` 用刚拿到的 `servers[].id`）。之后首页不再发任何 REST 查询。
3. **详情页（单台服务器）**：`GET /api/server?id=<id>` 拿当前指标 + `GET /api/history/all?id=<id>&hours=0.167`（默认 10 分钟历史曲线；用户切换时间范围才按所选 `hours` 重新请求一次）+ `wss /api/ws?subscribe=<id>` 拿实时更新。

除以上三个流程外，只允许再多一个接口：`POST /api/theme_options`（保存主题自身配置）。不要从其他监控项目（NetMonitor、各类内网面板、旧版迁移主题）沿用它们的路径、字段或调用方式；任何 `/admin/api`、`/updateDatabase`、`/clearHistory` 等管理端接口，以及不在上面流程里的请求，一律禁止。

### 三、消耗铁律（违反会耗尽用户的 D1 额度）

1. **`/api/config`、`/api/servers` 不得重复查询**：`/api/servers` 只在首页首次进入查一次；**禁止任何 `setInterval` 定时轮询**，所有数值刷新都从 WS `batchUpdate` 走。
2. **单页详情页必须用 `subscribe=<id>`**，不要用 `subscribe=all` 再在前端过滤——那会让后端把每台服务器的更新都推给浏览器。例外：详情页如果是首页上的弹窗且已有 `subscribe=all` 连接，直接复用该连接，不要新开。
3. **首页卡片的三网延时/丢包小图**：只用 `/api/servers` 返回的 `servers[].ping` / `servers[].loss` 窗口数组，**禁止**逐台请求 `/api/history/all?id=xx&hours=1` 来画卡片小图。数组为空或 `sysConfig.show_three_net_details !== true` 时直接不展示小图，不允许"自己拉历史补上"。
4. **详情页的历史曲线（包括 ping/loss）全部复用** `/api/history/all?id=&hours=xx`——历史行里已带 `ping_ct` / `loss_ct` 等字段，不要再单独发任何 ping/loss 历史查询。
5. `hours` 只允许：`0.167 / 0.5 / 1 / 6 / 12 / 24 / 48 / 96 / 168`，默认 `0.167`（10 分钟）；只在用户主动切换时间范围时查询。
6. **页面隐藏时止损**：监听 `document.visibilitychange`，隐藏时关闭 WS（保留最后一次数据静态展示），重新可见时按当前页面类型补一次 REST 再重连。
7. WS 断线重连用指数退避（延迟倍增、封顶、限制最大次数），禁止固定 1 秒死循环重连。
8. 遵守 `frontend_ws_timeout_minutes`（`/api/config`）：`0` 不限时；正数时达到时长主动断开并询问用户是否继续，用户不继续就不得静默重连。
9. 多 `apiBase`（多站）模式下，每个后端的 WS 只订阅该后端返回的服务器 ID；不要把全站所有 ID 发给每一个连接。
10. **首页渲染最多每秒一次**：WS 推送频率很高，不要把 `batchUpdate` 收到就直接触发重渲染。应先把样本攒到内存，最多每 1 秒批量合并并更新一次响应式数据（节流，不是每条消息都更新）；每秒内多条样本只取每台服务器的最新值。同时避免画面跳动：数值区用固定宽度/等宽数字（`font-variant-numeric: tabular-nums`），在线/离线状态切换不要引起卡片尺寸或布局变化，不要每帧重绘整页列表。

### 四、字段与数据语义（迁移主题最容易搞错的地方）

- WebSocket `batchUpdate` 结构：`updates[].samples[]`，指标对象按 `sample.data || sample.payload || sample.metrics` 读取。samples 是**增量**的：高频点只有 CPU/内存/Swap/网速；每次上报最后一个样本才携带报告级字段（磁盘、GPU、ping/loss、进程数等）。合并时对已知字段做覆盖式 merge，缺失字段保留旧值，不要整对象替换后把其他字段清成 undefined。
- ping/loss 字段三态：`false`（或未返回）= 未配置/未取样，**不显示**；`null` = 本轮探测超时，可显示 "Timeout/超时"；`0` 是有效数据（含 0% 丢包），**必须正常显示**。不许把 `null` 从图例里隐藏，也不许把 `false` 画成 0。
- 在线判定：`(Date.now() - last_updated) < 5 分钟`，用 `/api/servers` 的 `stats` 展示总数/在线/离线，不要自己重算一套不同口径。
- `disk`（磁盘 IO）对象可能缺失（全 0 或无有效数据时后端不返回），缺失时不渲染磁盘 IO 图表；磁盘 IO 只读 `disk` 对象。
- GPU 只用 `gpu_info`，为数组 `[{id,name,info}]`；REST 历史行里为同结构的 JSON 字符串，需先 `JSON.parse` 再取用。
- 流量单位是字节（B），网速字段单位 B/s，展示需自行格式化；`ram/disk` 单位 MB。
- 显示名：CT/CU/CM/BGP 使用 `/api/config` 的 `custom_ct_name` 等自定义名称；自定义节点名用 `node_1_name`~`node_4_name`，缺省显示 `Node 1`~`Node 4`。
- `price` 为 `"0"` 或 `"-1"` 表示免费，空白表示未设置；`is_hidden`、`ip_v4`、`ip_v6`、`auto_renewal` 等是字符串 `'0'|'1'`，不是布尔。

**`theme_options`：主题自己的配置存储**

`theme_options` 是后端专门留给第三方主题的运行时配置（任意 JSON 对象），用来保存用户可调整的主题个性化选项，比如布局模式、主题色、卡片密度、是否显示某类图表等。不要把它和站点级的标题/背景/开关（那些在 `sysConfig` 和后台外观设置里）混在一起。

- **读**：从 `GET /api/config` 响应的 `theme_options` 字段取（已包含在首次载入的那一次请求里，不要额外发请求）；用户未配置时是空对象 `{}`，所有键都必须准备默认值。
- **写**：只通过 `POST /api/theme_options`，body 为 `{ theme_options: {...} }`，需要 JWT（私有站还要 Turnstile 头）。该接口只更新主题自己的配置，不会碰 `site_options` 和其他外观设置，可以安全反复保存。
- **格式**：`theme_options` 必须是非数组对象，传数组、字符串或 `null` 会返回 `400 invalidThemeOptionsFormat`。
- **禁止**：不要调用 `save_settings` 等管理端接口写配置，也不要把主题配置塞进 `localStorage` 当唯一存储（换浏览器/设备就丢了，用户预期是存在服务端）。

### 五、鉴权与 Turnstile

- JWT 存 `localStorage.jwt_token`，请求带 `Authorization: Bearer <token>`；公开站点（`is_public === true`）匿名可访问。
- WS 不能带 Header：同域靠登录后 Cookie `cfsm_auth`，跨域在 URL 上追加 `token=<jwt>`。
- Turnstile：首次按 `/api/config` 的 `turnstile_site_key` 渲染组件，请求带 `X-Turnstile-Token`；验证成功后响应里的 `turnstile_verified` 要缓存（localStorage）并在后续请求改用 `X-Turnstile-Verified` 复用，**不要反复触发人机验证**。
- 收到 `401`：清除 `jwt_token`；主题页面跳转 `/admin#/admin` 登录（不要在主题里实现登录页）。收到 `403`：清 Turnstile 缓存并重验。主题自己发起的请求不要每 401 就 `location.reload()`，避免刷新循环。
- 主题行为完全由 `/api/config` 返回的 `is_public` 和 `turnstile_enabled` 驱动，不得写死假设：`turnstile_enabled !== true` 时不渲染 Turnstile 组件、不携带 Turnstile 头；`is_public === true` 时匿名可浏览，不得强制登录才能看列表。
- **交付前必须实测四种组合**（在后台分别开关"公开访问"和 Turnstile 后验证）：
  1. 公开站 + Turnstile 关：无任何凭证直接打开首页、WS 正常推送；
  2. 公开站 + Turnstile 开：首次完成人机验证后能看数据，验证凭证被缓存复用，刷新页面不反复弹验证；
  3. 私有站 + Turnstile 关：未登录时正确跳转 `/admin#/admin` 登录，登录后同域 Cookie / 跨域 `token=<jwt>` 的 WS 能连上并收到推送；
  4. 私有站 + Turnstile 开：JWT + Turnstile 同时生效，`/api/servers`、`/api/ws`、`/api/history/all` 全部可用，`401`/`403` 处理不引起刷新循环。
  任何一组组合下页面报错、死循环验证、数据空白的，主题不合格，不得提交。

### 六、其他强制要求

- 构建产物只有 `index.html` + `assets/` 两个东西；静态资源放 `assets/` 并用相对路径引用。
- 旗帜用 `/flags/<code>.svg`、OS 图标用 `/os-icons/<filename>`（默认皮肤静态文件）。
- 站点标题、背景图、自定义 head/脚本、深浅色（`preferred_theme`）、语言（`default_language`）由后台外观设置和 `/api/config` 控制，主题不得写死。
- 页面底部必须展示 `Powered by CF-Server-Monitor` 并链接到 `https://github.com/huilang-me/CF-Server-Monitor/`，建议附带 `/api/config` 返回的 `version`。
- 资源加载失败要让错误暴露出来，禁止静默跳转到其他页面。
- 跨域部署时提醒用户：每个 Worker 需配置 `CORS_ALLOWED_ORIGINS` 环境变量（纯 origin、逗号分隔）。

### 七、GitHub Actions：自动构建静态页面到分支

主题仓库必须附带一个 workflow，满以下要求（由你自己编写，不需要模板）：

- 推送主分支（`main`/`master`）或手动触发时，自动构建静态页面，并把产物推送到专门用于 GitHub Pages 的分支，分支名固定为 `dist`。
- 构建分支的每次提交必须**保留触发本次构建的源码 commit 说明**，提交信息形如 `新增 GPU 展示卡片`；手动触发时取当时 HEAD 的 commit 说明。
- 往目标分支**追加提交、保留每次 build 的历史**，不得用 `git init` + `push -f` 之类 force push 写法抹掉历史；加 `concurrency` 防止并发推送打架。
- `API_BASE`、`TITLE`、`BACKGROUND_IMAGE`、`CSP_API`、`CSP_STATIC` 等运行时配置全部通过仓库 Secrets 注入环境变量，不得把 Worker 地址写进仓库文件。
- 提醒用户：在仓库 Settings → Pages 里选该分支作为托管源，并开启 Actions 写权限（`contents: write`）。

### 八、完工自查清单（提交前逐条核对）

- [ ] 全局搜索代码：只用了 `/api/config`、`/api/servers`、`/api/server`、`/api/history/all`、`/api/ws`、`/api/theme_options`，没有任何其他请求路径
- [ ] `/api/config` 与 `/api/servers` 各只查一次，全工程没有 `setInterval` 轮询 REST
- [ ] 实时刷新全部走 WS `batchUpdate`；独立详情页用 `subscribe=<id>`，只有首页弹窗详情复用 `subscribe=all`
- [ ] 首页卡片 ping/loss 小图只用 `servers[].ping` / `servers[].loss`，没有逐台查历史
- [ ] 详情页历史（含 ping/loss）只走 `/api/history/all?id=&hours=xx`，无单独查询，且只在切换时间范围时请求
- [ ] `visibilitychange` 会关闭 WS，恢复时先补一次 REST 再重连
- [ ] 首页 WS 更新经节流，渲染最多每秒一次；数字宽度固定、状态切换不引起布局跳动
- [ ] ping/loss 的 `false` / `null` / `0` 三态显示正确
- [ ] `batchUpdate` 样本按增量合并，字段不会被清掉
- [ ] 管理入口只跳 `/admin#/admin`，主题内无登录页、无管理页
- [ ] 产物仅 `index.html` + `assets/`
- [ ] 站点标题/背景/语言/主题色均来自 `/api/config` 与后台设置，无写死
- [ ] 已实测四种组合：公开/私有 × Turnstile 开/关，均无报错、无反复验证、无刷新循环
- [ ] 附带自动构建 workflow：推送主分支即构建并追加提交到 Pages 分支，提交信息保留源码 commit 说明，未 force push

请先确认已理解以上规则，再开始实现。如某个 UI 需求和上述规则冲突（例如需要"每 10 秒刷新历史"），必须主动提出并按规则允许的 WebSocket/REST 方式重新设计，而不是绕过规则。
