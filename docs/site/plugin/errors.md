# 错误码

壳子错误经 IPC 返回 `Error.message`，或经 `shell:event` 的 `plugin-error` 推送。字符串前缀可匹配。

## 安装 / 加载

| 消息（前缀/全文） | 触发 | 处理 |
|-------------------|------|------|
| `plugin.json not found in <dir>` | 目录内无清单 | 确认选中的是插件根目录 |
| `invalid plugin.json: not valid JSON` | JSON 语法错误 | 校验逗号、引号、尾逗号 |
| `invalid plugin.json: missing required fields (id, name, version, main)` | 缺必填字段 | 补齐四字段 |
| `plugin not installed: <id>` | 打开未安装插件 | 先安装或用开发者加载 |
| `sample not found: <src>` | 示例包路径无效 | 检查 `plugins-samples` 是否完整 |
| `not implemented` | zip / `.enestplugin` 安装 | 当前为 stub，请用本地目录加载 |

## 权限

| 消息 | 触发 | 处理 |
|------|------|------|
| `permission denied: <perm>` | 未声明权限却调用 API | 在 `plugin.json` → `permissions` 增加对应键 |

`<perm>` 取值见 [权限说明](permissions.md)。

## 协议 / 资源

| 现象 | 触发 | 处理 |
|------|------|------|
| 静态资源 404 / 拒绝 | 路径穿越（`..`）或超出插件根目录 | 使用相对路径，不要跳出插件目录 |
| 白屏 + Console CSP | 生产 CSP 限制 | 避免内联脚本/外链，资源放插件目录内 |

## 运行时事件（plugin-error）

主进程在加载失败时向壳子发送：

```ts
// 概念结构，具体字段以 shared/types 为准
{
  type: 'plugin-error',
  pluginId: string,
  message: string
}
```

可在开发者页日志区查看；插件自身错误请用 DevTools Console。

## 建议排查顺序

1. DevTools Console 是否有 JS 异常
2. `plugin.json` 是否合法、`main` 是否可访问
3. `permissions` 是否覆盖调用的 API
4. 开发态端口 / `development.main` 是否正确
5. 仍失败：关 Tab 重开，或卸载重装本地目录

相关：[调试与热更新](debug.md) · [FAQ](faq.md)
