# GitHub 登录与私库同步

## 推荐：一个官方 GitHub App，不部署服务器

发布者只需注册一次 GitHub App。普通用户不需要注册应用、配置回调、创建令牌或运行 Git。不要把 Client secret、私钥或 PAT 放入桌面构建。使用私有仓库而不是 secret gist：后者是未公开列出，并非只有所有者才能读取。

官方源码构建已默认使用 [eNest Desktop Sync](https://github.com/apps/enest-desktop-sync)，无需填写环境变量。以下步骤仅供更换发布者应用时使用。

1. 在 [GitHub App 注册页](https://github.com/settings/apps/new) 填写应用名称和产品主页，选择 **Any account**。开启 **Enable Device Flow**，保留 **Expire user authorization tokens**；关闭 Webhook。不需要 Callback URL、Setup URL 或安装时 OAuth 重定向。
2. 仓库权限只开 **Repository creation → Read and write** 和 **Contents → Read and write**；GitHub 强制附带 **Metadata → Read-only**。不需要 Administration、组织或账号权限。安装者只需向应用开放用于同步的仓库，无须开放全部仓库。
3. 将公开的 **Client ID**（不是数字 App ID）和应用 URL `/apps/` 后的 **slug** 分别配置为 `ENEST_GITHUB_CLIENT_ID`、`ENEST_GITHUB_APP_SLUG`，设置 `ENEST_GITHUB_DEVICE_FLOW=1`，不配置 `ENEST_GITHUB_TOKEN_EXCHANGE_URL`。本地开发可用 `.env.local`；CI 使用同名 Actions Variables。改完重启桌面开发进程，发行版需重新构建。
4. 「设置 → 个人资料 → 使用 GitHub 登录」会复制本次短码并打开系统默认浏览器。用户核对 GitHub 账号、粘贴短码并授权。桌面向 GitHub 轮询结果、回到前台并显示头像，不依赖浏览器回调 localhost。能静默记住登录时，访问及刷新凭据只以密文保存在本机。

授权页上的应用图标由 GitHub 托管，与用户头像无关。发布者在 GitHub App 的 **General → Display information → Upload a logo** 上传打包使用的 `build/icon.png`；未上传时 GitHub 显示按应用名生成的默认图案。更换桌面图标不会自动更新 GitHub。

### 登录后如何记住这台电脑

- GitHub 授权和本机凭据保存是两件事。正常情况下 eNest 自动加密保存，无需再确认一次。Windows 使用当前用户的 DPAPI；macOS 和 Linux 用 eNest 专属的随机密钥加密本机凭据，密钥分别存入已解锁的登录钥匙串和 Secret Service（需要 `libsecret`）。不会请求解锁、自动批准系统权限或启用明文密码库。这个策略只适用于 GitHub 账号，不改变插件保险库或 MCP 的权限。
- 无法静默使用密钥库时，刚授权的账号仍可同步，但只在本次 eNest 会话有效。个人资料会提示重启后需要重新登录。要记住登录，可自行解锁系统密钥库后重新登录。读取已保存凭据时遇到暂时锁定不会删除密文。
- 从旧版升级的 macOS / Linux 用户需重新登录一次。eNest 不会为了迁移旧令牌而访问 “Electron Safe Storage”；旧密文在重新登录前保留。Windows 继续使用已有密文。退出登录会清除本机凭据，令牌不会随插件快照上传。

### 使用与恢复

- 输入自定义仓库名（默认 `enest-sync`）后点击「连接或创建私库」。eNest 先查本人同名仓库，再按需请求 GitHub 创建 **private** 仓库。不能访问、同名公开、权限不足或仓库身份改变时，不会退回公开仓库或覆盖其他文件。GitHub 可能将“没有权限”也返回为 404；按界面入口完成个人账号安装或选定仓库，再重试即可。
- 登录和安装是两步：登录拿到头像不代表已授予仓库权限。在 GitHub 首次安装时，选 **Only select repositories** 需要至少选一个现有仓库。如果没有愿意授权的仓库，可以先在 GitHub 建一个空的专用私库并选中它；无需把已有项目或所有仓库交给 eNest。
- 连接仅初始化 `.enest-sync.json`；勾选插件并确认上传后，才会提交插件快照。每个插件的文件与清单更新属于同一个 Git 提交，其他文件不参与。GitHub 的访问控制保护私库，但这不是端到端加密；Git 历史会保留历史版本。不要上传不希望托管的业务数据。
- 换电脑后登录同一账号，eNest 最多查找 500 个可访问的个人私库，核对仓库 ID 和同步标记。候选不唯一或超过查找范围时不会自动绑定，可在「查找我的私库」中选择，或直接输入原名。可恢复勾选项，或在**这台电脑**开启「自动恢复全部」：立即、登录及启动时下载，不自动上传或安装插件。运行中、超限、版本冲突的条目单独报告；覆盖冲突需要再次确认。
- 支持宿主管理的插件 KV、私有文档、图片资源及已完成的输出文件。每个插件快照（包括编码后的附件）不超过 16 MiB，不拆分、不静默截断。系统保险库、授权、宿主及插件设置、浏览器会话、插件程序、外部文件和插件自建目录不属于快照。页面的本机磁盘占用与云端快照大小不一定相同。
- 断开仓库或退出登录不会删除 GitHub 上的数据。访问授权和安装权限可以在 GitHub 设置中撤销。
- 桌面端的登录、头像和同步请求沿用「设置 → 网络代理」；系统浏览器的授权页使用浏览器自己的代理。临时网络错误或短暂限流时，只读请求最多自动重试两次。建库和提交不会自动重发；可在结果中仅重试失败插件，程序会先读取云端，已经写入的相同快照不会重复提交。权限不足或需要长时间等待时请按提示处理，再手动重试。

GitHub 文档：[设备授权](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[创建个人仓库及所需权限](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)、[Gist 可见性](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists)。

## 可选兼容：自行托管的 OAuth 登录交换服务（仅登录）

`github-oauth-exchange.mjs` is a publisher-operated server example, not a plugin
API, SDK, or service bundled with the desktop app. It exports
`createGithubExchangeServer` for the isolated authentication fixture.

### Run

Use Node.js 22 or newer. Supply these values through the deployment environment
or secret manager, never through committed files or shell history:

- `GITHUB_CLIENT_ID`: the publisher's GitHub OAuth App identifier.
- `GITHUB_CLIENT_SECRET`: the server-only OAuth App secret.
- `PORT`: optional loopback port; defaults to `8787`.

From the repository root:

```sh
node scripts/auth/github-oauth-exchange.mjs
```

The example listens on `127.0.0.1` and accepts JSON `POST` requests at
`/oauth/github/exchange`. Expose that endpoint through an HTTPS reverse proxy.
Configure edge request-body, connection, timeout, and rate limits. The example
limits the directly connected IP and does not trust forwarded headers; shared
or multi-instance deployments need an appropriate entry-point rate limiter.
Do not log authorization codes, verifiers, request bodies, secrets, or tokens.

### Desktop Configuration

Configure the desktop build with only the public values
`ENEST_GITHUB_CLIENT_ID` and `ENEST_GITHUB_TOKEN_EXCHANGE_URL`. The latter points
to the HTTPS exchange endpoint. Never include `GITHUB_CLIENT_SECRET` in the
desktop bundle. Rebuild and restart the desktop app after changing its build
configuration. CI variables must be explicitly passed to the build environment.

Register the OAuth App's loopback callback as `http://127.0.0.1/callback`; the
desktop app chooses the callback port at runtime. The exchange example accepts
only the loopback callback path and forwards the PKCE verifier to GitHub.
Running this example or its isolated fixture does not confirm that a real
publisher OAuth App, proxy deployment, or system credential store is configured.
