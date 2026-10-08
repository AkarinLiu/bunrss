# bunrss

Bun + `bun:sqlite` + Vite/Vue 的 RSS 聚合在线阅读器。多用户、无 ORM、零原生依赖。

## 技术栈

- **运行时**：Bun（`Bun.serve` 路由、`setInterval` 定时刷新、`Bun.password` 鉴权、`bun:sqlite` 存储）
- **数据库**：SQLite（WAL），手写 SQL + 序号迁移，FTS5 `trigram` 全文索引
- **前端**：Vite + Vue 3 + Vue Router + Pinia
- **抓取**：`rss-parser`（RSS/Atom），`@mozilla/readability` + `linkedom`（全文抓取）

## 快速开始

```bash
bun install
bun run dev      # API :3000 + Vite :5173
```

打开 http://localhost:5173 ，首次会进入 **setup 向导**：创建的第一个账号即管理员，随后可选择性地添加订阅源。之后其他人在登录页注册的账号均为普通用户。

生产模式：

```bash
bun run build    # 构建前端到 web/dist
bun run start    # Bun.serve 同时托管 API + 前端静态资源（:3000）
```

## Docker

```bash
docker compose up          # 首次会先 bun install + bun run build，需要等一会儿
# 打开 http://localhost:3000 —— 首次仍是 setup 向导
docker compose down
```

- 直接用 Bun 官方镜像 `oven/bun:1.4`，启动命令是 `sh -c "bun install && bun run build && bun run start"`。
- **只挂源码**（`server/`、`migrations/`、`web/`、`package.json`、`bun.lock`、`tsconfig.json`）。
- `node_modules` 和 SQLite 数据库分别放在命名卷 `bunrss-node_modules` / `bunrss-data`，容器不会写进宿主仓库，也不会和本机 `bun run dev` 抢同一个库。
- 容器是独立实例，首次打开仍是 setup 向导。重置：`docker compose down -v`。
- 换端口：`BUNRSS_PORT=8080 docker compose up`。
- 想要自包含的生产镜像（多阶段构建、只装生产依赖）就用 `Dockerfile`：
  `docker build -t bunrss . && docker run -p 3000:3000 -v bunrss-data:/data bunrss`

## 脚本

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 同时启动后端（watch）与 Vite 开发服务器 |
| `bun run dev:server` / `dev:web` | 单独启动后端 / 前端 |
| `bun run build` | 构建前端 |
| `bun run start` | 生产模式启动（含静态托管） |
| `bun run migrate` | 应用 `migrations/*.sql`（服务启动时也会自动执行） |
| `bun run check` | 临时库上自检 setup 首用户管理员 + 配额限制逻辑 |
| `bun run check:greader` | 临时库上自检 Google Reader API 的 id 往返、items/contents、edit-tag |
| `bun run e2e` | 无头浏览器跑一遍 setup 向导（构建 + 临时库 + 随机端口） |
| `bun run smoke` | 对运行中的服务跑 API 冒烟测试 |

## 环境变量

均可省略，默认值见下（写入 `.env` 可覆盖）：

```
DATABASE_URL=./data/bunrss.db
PORT=3000
```

可选 SMTP（设置 `SMTP_HOST` 即启用发信，同时**强制**新注册用户验证邮箱后才可登录；已有账号视为已验证，不会被锁死）：

```
APP_URL=https://rss.example.com     # 验证邮件里链接的站点地址；浏览器请求会回落到自身 Origin
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false                   # 465 用 true（隐式 TLS）；587/25 自动 STARTTLS
SMTP_USER=
SMTP_PASS=
SMTP_FROM=bunrss <noreply@example.com>
```

## 架构

```
server/
  db.ts        bun:sqlite 连接 + PRAGMA + 启动时执行迁移
  migrate.ts   极简迁移 runner（migrations/*.sql，记录在 _migrations）
  http.ts      JSON / cookie 辅助、错误 code、邮件链接的站点地址
  i18n.ts      服务端错误消息目录（zh-CN / en）+ Accept-Language 解析
  mail.ts      SMTP 发信（nodemailer）+ 验证邮件文案；SMTP_HOST 决定发信与强制验证是否开启
  auth.ts      注册、登录（用户名或邮箱）、登出、session 校验、用户名设置；邮箱验证 token；首启 setup / needsSetup（Bun.password + 随机 token）
  library.ts   订阅 / 已读星标 / 标签写入，唯一的配额校验点
  settings.ts  实例设置（订阅上限、星标上限、注册用户上限、是否允许注册），0 = 不限
  fetcher.ts   条件 GET 抓取、upsert 文章、全文抓取、定时刷新
  index.ts     Bun.serve 路由（/api/*、/api/admin/*）+ 前端静态托管
  greader.ts   Google Reader 兼容 API（/reader/api/0/*、/accounts/*），API token 鉴权
  importexport.ts  文章数据迁移（中立 Google Reader JSON，导入 FreshRSS / Tiny Tiny RSS）
  smoke.ts        API 冒烟测试
  core.check.ts   setup + 配额 + 标签逻辑的自检（临时库，不需要起服务）
  greader.check.ts  Google Reader API 兼容性自检（临时库，不需要起服务）
migrations/    0001_init.sql … 0011_email_verify.sql（按序号自动应用）
web/           Vite + Vue 前端（api.ts / store.ts / router.ts / i18n.ts / views/）
e2e.setup.ts   setup 向导 + 管理后台的无头浏览器回归检查
```

`bun run e2e` 需要浏览器：首次执行 `bunx playwright install chromium --only-shell`。

多租户模型：`feed` 全局共享（同一 URL 只抓一次），用户通过 `subscription` 订阅，已读/星标存在 `article_state`。

## 功能

- **首启 setup 向导**：库中无用户时强制进入向导，创建的第一个账号为管理员（`user.is_admin = 1`）；向导第二步可挑选/粘贴订阅源。已有用户后 `/api/setup` 一律 409
- 多用户登录（注册 / 登录 / 登出，30 天 session cookie；向导之后注册的账号为普通用户）；账号有唯一用户名，登录时用户名或邮箱均可
- **用户名**：注册 / setup 时必填，3-32 位字母（保留大小写）、数字、`_` 或 `-`；全局唯一且不区分大小写（`Alice` 与 `alice` 视为同一用户名），创建后不可更改。登录时用户名或邮箱均可；历史空用户名账号可在设置页补设一次；Google Reader 客户端的 ClientLogin 同样接受用户名
- **邮箱验证（可选强制）**：配置 `SMTP_HOST` 后，公开注册的账号会收到一封验证邮件，验证前无法登录（`/api/auth/login` 返回 403 `email_unverified`，登录页可一键重发）；链接走 `POST /api/auth/verify`，token 一次性、24 小时有效。setup 创建的首个管理员与后台创建的账号直接视为已验证，存量账号也默认已验证，因此开启该功能不会把实例锁死；未配置 SMTP 时验证逻辑完全不生效，注册行为与从前一致
- 订阅管理：添加 / 取消订阅，分组（category）归类，自定义标题
- 文章列表：按订阅源 / 分组 / 未读 / 星标筛选，未读计数
- 阅读：正文渲染（DOMPurify 消毒）、标已读 / 标星、抓取全文
- **文章标签**：自由命名的多对多标签（每用户独立，名称不区分大小写且唯一）。在阅读器给文章加 / 去标签，侧栏按标签浏览、显示未读数，设置页可重命名 / 删除
- 搜索：FTS5 全文索引（`trigram` 分词，支持中文子串）
- OPML 导入 / 导出
- **文章数据导入 / 导出**：Google Reader 中立格式 JSON（携带已读 / 星标 / 标签）。支持 FreshRSS 的「收藏 / 标签」导出、Tiny Tiny RSS 的 `export_ttrss`，以及**二者的 ZIP 包**（FreshRSS 合并导出 → 内含 OPML + JSON；tt-rss `data_migration` → `{articles:[…]}` 批次）。ZIP 里的 OPML 成员会导入订阅源列表，JSON 负责已读 / 星标 / 标签；目标里还没有的文章会连同内容一并写入，旧收藏不丢。反过来导出 bunrss 的已读 / 星标 / 标签文章，可回迁 FreshRSS。OPML 仍可单独导入 / 导出订阅（`GET/POST /api/data`、`GET/POST /api/opml`）
- **书签快速订阅**：「设置 → 浏览器书签快速订阅」把按钮拖到书签栏；在任意网站点击它，会打开订阅页并自动发现该页声明的 RSS / Atom 源（`<link rel="alternate">`），可多选后一次订阅（服务端 `GET /api/discover`）
- **订阅源图标**：抓取时读取站点首页声明的 `<link rel="icon">`（png / svg / apple-touch-icon 均可）并存到 `feed.icon_url`，客户端优先用它、失败或未声明时回落到 `/favicon.ico`；每个源只额外抓取一次主页
- **多语言**：界面文案与 API 错误消息支持简体中文 / English；登录页与「设置 → 语言」可切换，选择保存在浏览器本地，默认简体中文。服务端按请求的 `Accept-Language` 返回对应语言的错误消息
- 深色模式（浅色 / 深色 / 跟随系统，跟随系统时按 OS 偏好自动切换）、键盘快捷键
- **管理后台**（`/admin`，仅管理员）：实例概览、用户列表（提升/降级管理员、删除用户）、设置配额
- **登录 IP 记录**：注册 / 登录 / setup 建立 session 时记录来源 IP（`login_log`），管理后台用户列表显示「最近登录」；超过 30 天的记录随 cron 清理
- **配额限制**：每用户订阅数上限、星标数上限、注册用户总数上限（`0` = 不限）。服务端在订阅、星标、OPML 导入三处统一校验；前台超出时给出明确提示，订阅栏会显示 `n / max`
- **移动端适配**：窄屏（≤768px）下侧栏收起为抽屉，文章列表与正文二级切换（点开文章进正文，左上角返回）；触控目标加大
- **Google Reader 兼容 API**：原生客户端（Reeder / NetNewsWire / FeedMe 等）可直接连接，见下
- **自动刷新**：服务端每 15 分钟抓取一次过期源（`setInterval`，跨平台）；前端默认打开时拉取一次、每 5 分钟请求 `/api/refresh?stale=1` 拉新、每分钟同步订阅/未读/已读状态（跨客户端生效），可在「设置 → 自动刷新」关闭

### Google Reader 兼容 API

管理员在「管理后台 → 用户行 Token」为用户生成 API token（仅显示一次）；用户也可在「设置 → 客户端 Token」自行生成 / 撤销。客户端选择「Google Reader / FreshRSS」类型，服务器地址填 `http(s)://站点/api/greader`（设置页会直接显示该地址），用户名填邮箱，密码填该 token。

所有端点挂在 `/api/greader` 下：`accounts/ClientLogin`（也接受 `GoogleLogin`）、`reader/api/0/token`、`reader/api/0/user-info`、`reader/api/0/subscription/list`、`subscription/edit`、`subscription/quickadd`、`tag/list`、`unread-count`、`stream/contents`（含 `/stream/contents/*`）、`stream/items/ids`、`edit-tag`、`mark-all-as-read`。鉴权用 `Authorization: GoogleLogin auth=<token>`；token 与登录密码分离，可随时撤销。

注意：Fluent Reader 等客户端不接受 `localhost` 形式的端点（会提示「请正确输入 URL」），请改用 `127.0.0.1` 或局域网 IP。

### 键盘快捷键

`j` / `k` 下一篇 / 上一篇 · `m` 切换已读 · `s` 切换星标 · `o` 打开原文

## 说明

- 搜索词 **≥ 3 个字符**走 FTS5 全文索引；更短的走 `LIKE`（trigram 至少需要 3 字符）。
- `tokenize='trigram'`（不是 `tokenizer`）。
- 没有 ORM：查询是手写 SQL，行类型手写接口；SQL 集中在 `server/index.ts`。
- 配额校验只写在 `server/library.ts` 里，`/api/feeds`、`/api/opml`、文章星标三条路径共用，不重复实现。
- 登录 IP 取值顺序：优先 `X-Forwarded-For` 第一跳（反代场景），否则用 `server.requestIP()` 的 socket 对端地址。**没有反代时 XFF 可被客户端伪造**，所以它是审计线索，不是安全控制。
- 管理员只是多一个 `is_admin` 标记 + `/admin` 页面；注册的账号都是普通用户。是否允许注册由 `setting.allow_registration` 控制（默认开启），注册总数由 `setting.max_users` 控制（0 = 不限），都在 `/admin` 的「配额限制」里切换。关闭 / 超限后 `/api/auth/register` 返回 403，登录页也隐藏注册入口（setup 向导不受影响，首个管理员始终可建）。用户数校验在 `server/auth.ts` 的事务内，与邮箱 / 用户名查重同批执行，避免并发超额。
- 用户名（`user.username`）可空但唯一且不区分大小写（`CREATE UNIQUE INDEX ... (username COLLATE NOCASE)`，NULL 互不冲突）；大小写照原样存储，仅查询与索引用 `COLLATE NOCASE`。登录按 `email = ? OR username = ? COLLATE NOCASE` 匹配。`setUsername` 只允许给空用户名账号补设一次，已有用户名则返回 409，即用户名不可更改。
- 标签是 `tag`（每用户、名称 `COLLATE NOCASE` 唯一）+ `article_tag`（多对多）两张表，删除用户 / 文章 / 标签都级联清理。所有标签读写和「文章归属」校验集中在 `server/library.ts`，`setArticleState` 与 `addArticleTag` 共用同一个 `ownsArticle` 守卫，不重复实现。
