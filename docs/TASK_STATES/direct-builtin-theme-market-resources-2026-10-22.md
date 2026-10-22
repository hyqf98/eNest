# 内置主题直接启动与市场资源清理

## 启动与主题包

- 删除首次启动选择主题组件、候选选择/确认服务及对应专用样式；App 不再读写 `general.themeSetupComplete`。
- 默认主题声明集中为 `src/shared/theme/defaultTheme/package.ts` 的 `DEFAULT_THEME_PACKAGE`。外观、首页和启动动画仍由该源码包及 `src/renderer/themes/default/` 提供，不在插件仓发布或安装。
- ThemePackRegistry.load 直接从编译定义加载内置包，可写 registry.json 只保存第三方扩展，磁盘数据不能覆盖或删除内置保底主题。
- 新安装直接进入内置启动动画与首页；已有有效第三方主题选择仍恢复，不强制覆盖用户选择。主题插件注册、设置切换、配套首页事务和故障回退保留。
- Home 在 IPC 就绪后立即隐藏预热，与外观读取、启动动画和轻量会话恢复并行；ready/路由ACK/动画完成后才显示，不再等待首启确认。
- 历史完成标记在主进程设置与浏览器mock读写边界忽略/清理，不新增替代标记；启动错误保留单独的重试入口。

## 市场图标与图片

已定位两个根因：localPreview 用短目录名与完整manifest.id比较，导致本地预览被跳过；远程HTTPS图标在Home发布层被丢弃，且资源协议仅支持本地manifest。

- 本地预览按ID末段匹配目录，以完整ID作为键。构建包优先，没有dist时只读取源码元数据与public/assets，不启动开发服务器/后端、不把预览视为可运行的已安装插件。
- Registry按dev、installed、preview、remote选取整个条目的资源来源，图标/截图/README共同使用；缺少槽位不混入另一版本素材。
- 首页只接收 `enest-home://catalog/<id>/...` 受控槽位。远程官方市场素材由主进程Node fetch代取，沿用宿主代理；保持Home CSP与网络限制，不直接开放HTTPS。
- 远程资源带HTTPS官方仓库/重定向白名单、10秒超时、字节/类型/图片签名检查、有限缓存及请求合并。源码资源复用assets到public/assets映射与路径/符号链接防护。
- README里的相对图片仅映射到同插件已声明截图槽位，不开放任意文件或外部图片入口。

## 卡片元信息

- 插件卡片及精选横幅移除下载量显示，改为真实安装包大小，来源是registry的asset.size（最终archive bytes）。
- 以B/KB/MB/GB等格式显示；无大小、非正数或非法值显示“—”，提示未知，不用下载量或源码目录估算值冒充。

## 检查边界

- 本轮执行TypeScript检查与生产构建，未执行任何测试命令或GUI/原生验收，按用户偏好留给用户实测。
- 对首启退役、资源选择/网络边界及README映射相关测试源码作了同步更新，但未将其称作通过。
- SDK类型、开发者标准和skill同步更新；未提交或推送代码，不改用户真实主题/配置数据。
