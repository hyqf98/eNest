# eNest 账号登录接入

个人资料是独立的设置 Tab。界面从主进程获取登录方式，目前为 GitHub；不再要求最终用户填写 Client ID。未配置的开发版本显示登录暂不可用，本地功能不受影响。

## 发布方一次性配置

1. 在 GitHub 注册 eNest 自己的 OAuth App。Homepage URL 填官网，Authorization callback URL 填 `http://127.0.0.1/callback`。GitHub 允许 loopback 回调使用运行时分配的端口。
2. 在服务器部署 [可运行的交换端点示例](../examples/github-oauth-exchange.mjs)，配置 `GITHUB_CLIENT_ID` 与 `GITHUB_CLIENT_SECRET`。Node.js 22 以上运行 `node docs/examples/github-oauth-exchange.mjs`，默认仅监听 `127.0.0.1:8787`，由反向代理以 HTTPS 暴露 `/oauth/github/exchange`。生产环境配置请求体上限、超时、连接限制与限流；示例按直连 IP 限流，不信任客户端提供的转发头，多实例部署应在入口统一限流。禁止记录请求体、授权码或响应 token。
3. 为桌面应用构建配置以下公开环境变量（可写在未跟踪的 `.env.production.local` 中）：

```dotenv
ENEST_GITHUB_CLIENT_ID=你的应用公开标识
ENEST_GITHUB_TOKEN_EXCHANGE_URL=https://你的登录服务/oauth/github/exchange
```

4. 重启开发主进程或重新构建发行包。界面将自动启用 GitHub 按钮。Electron 内部网络通过 `net.fetch`，沿用壳的代理设置。

Client Secret 只保存在服务器。GitHub 的授权码交换仍需要 Secret，PKCE 不能替代它。Electron 包中仅含公开 Client ID 和交换 URL，不应包含任何服务端密钥。只配置 Client ID 时不会误显示为可用。

如发布方明确选择设备码模式，可启用 OAuth App 的 Device Flow 并设置 `ENEST_GITHUB_DEVICE_FLOW=1`；无交换端点时才启用此模式。它需要用户输入短码，不是默认浏览器回调体验。

## 浏览器到桌面

点击登录 → 主进程预占登录会话 → 创建 `127.0.0.1` 随机端口 → 默认浏览器打开 GitHub（随机 state + PKCE S256，`read:user` scope）→ 回调校验 state → 服务端携带 Secret 交换 code → 拉取资料 → 系统密钥库加密保存 token → 发布资料事件并唤醒主窗口。

回调只接受一次正确 state 的请求。错误 state 不会取消当前登录；页面不反射 GitHub 提供的错误文本。只有凭据已加密保存、资料已交给宿主设置存储，浏览器才显示成功（资料沿用宿主设置的防抖持久化）。取消、超时与退出登录都会关闭回调、中止登录网络请求并使旧网络结果失效，避免重新写入已退出账号。登录中切换设置 Tab 后再回来仍可继续等待、重新打开浏览器或取消。系统密钥库不可用时拒绝保存凭据。

## 扩展登录方式

`src/shared/types/account.ts` 是渲染层契约，`src/main/auth/accountAuthService.ts` 是宿主提供方注册表。新提供方实现登录/取消/退出、账号/会话查询和可用性适配，并发布通用 `account-login-status` 事件即可；页面按提供方列表生成按钮。认证提供方由壳维护，不开放给普通业务插件注册宿主登录处理器。

GitHub 老接口暂保留兼容；旧 `profile.githubClientId` 数据不再用于启动登录，也不再显示输入框。

## 验证范围

自动测试覆盖本地真实 HTTP 回调、state/重放/取消、并发登录保护、打开浏览器失败、注销与异步刷新竞态、交换端点参数与秘密隔离。发行前仍须用发布方真实 OAuth App 检查浏览器同意授权、拒绝、代理网络及系统密钥库。当前尚未注册应用，不能将本地模拟验证视为真实 GitHub 账号授权完成。

参考：[GitHub OAuth App 授权文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。
