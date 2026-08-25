# 睡眠状态与 ChatGPT MCP 服务

这个 Netlify Function 保存当前睡眠会话和每次触发证据，并提供可连接到 ChatGPT 的远程 MCP。它可以单独作为 MCP-only 服务运行；iPhone 快捷指令和 Bark 都是可选增强。

## 环境变量

只连接 ChatGPT MCP 时，在 Netlify Site configuration → Environment variables 中设置：

- `MCP_APPROVAL_PASSWORD`：至少 16 个字符；ChatGPT 发起 OAuth 连接时在浏览器授权页输入。它只保存在 Netlify 环境变量中。

如果还要连接 iPhone 快捷指令与 Bark，再设置：

- `SLEEP_GUARD_SHORTCUT_TOKEN`：至少 32 个随机字符；只复制到使用者 iPhone 的快捷指令请求头。
- `BARK_DEVICE_KEY`：Bark 测试 URL 中的设备 key；只保留在 Netlify。
- `BARK_API_ORIGIN`：默认 `https://api.day.app`，只有自建 Bark server 时才修改。
- `BARK_ICON_URL`：可选的公开 HTTPS 头像地址；未设置时使用站点内置的抽象头像。

## 部署

把 Netlify 项目的 base directory 指向本仓库的 `netlify` 目录。接口为：

```text
POST https://<site>.netlify.app/api/sleep-guard-event
```

请求头：

```text
Authorization: Bearer <shortcut-token>
Content-Type: application/json
```

三个事件体：

```json
{"event":"sleep_guard_started","source":"ios_shortcuts"}
```

```json
{"event":"blocked_app_opened","app_name":"小红书","source":"ios_automation"}
```

```json
{"event":"sleep_guard_ended","source":"ios_shortcuts"}
```

`sleep_guard_started` 可选传 ISO 8601 格式的 `ends_at`，但必须在当前时间后的 24 小时内；未传时默认在上海时间下一次上午 11:00 自动过期。

如果没有先发送 `sleep_guard_started`，上海时间凌晨 1:00 至上午 11:00 的第一次 `blocked_app_opened` 会自动开启守卫、计为第一次偷开，并返回 `auto_started: true`。若使用者已发送 `sleep_guard_ended`，当天上午 11:00 前不会再次自动开启。

## 状态与证据

- 当前会话：`sleep-guard-events/state/current`
- 事件：`sleep-guard-events/events/YYYY-MM-DD/<timestamp>-<uuid>`
- 状态更新使用 ETag 条件写入并在冲突时重试，避免几乎同时打开 App 导致次数被覆盖。
- 事件会先写入；配置了 Bark 时再发送推送，Bark 失败时接口返回 `502`，但事件仍保留。
- 未配置 Bark 时仍可正常保存状态和使用 MCP，不会尝试发送推送。

成功响应只包含会话状态、次数、阶段和事件 ID，不包含 Bark key：

```json
{
  "ok": true,
  "event": "blocked_app_opened",
  "active": true,
  "attempts": 1,
  "stage": "first_warning",
  "auto_started": false,
  "ignored": false
}
```

## ChatGPT MCP

远程 MCP 地址：

```text
https://<site>.netlify.app/mcp
```

它提供两个工具：

- `activate_sleep_guard`：使用者在 ChatGPT 明确说晚安或准备睡觉时开启守卫。
- `get_sleep_guard_status`：只读查询当前状态和偷开次数。

MCP 不接受快捷指令 Token，也不依赖 Bark。连接使用 OAuth 2.1 Authorization Code + PKCE：ChatGPT 发起连接后，浏览器会显示密码授权页；输入 Netlify 中的 `MCP_APPROVAL_PASSWORD` 后继续。单次授权最多允许五次密码尝试，授权码只能使用一次，访问令牌保存在独立的 `sleep-guard-mcp-auth` Blob store 中并在 90 天后失效。

`activate_sleep_guard` 会直接在 Netlify Blobs 中记录睡眠状态，因此 MCP-only 部署不需要 `SLEEP_GUARD_SHORTCUT_TOKEN`。没有 iPhone 自动化时，它只记录和查询状态，不会在 Android 上拦截 App。

OAuth 元数据、动态客户端注册、授权与令牌端点均由同一个 Netlify Function 提供。任何未认证的 `/mcp` 请求都会返回带 `resource_metadata` 的 `WWW-Authenticate`，不会调用睡眠状态机。
