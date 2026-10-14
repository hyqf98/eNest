/** Built-in, plugin-scoped services are available without a consent decision. */
export function PluginBuiltinCapabilities() {
  return (
    <div className="plugin-builtin-capabilities">
      <h3 className="label">基础能力 <span>直接可用</span></h3>
      <p className="desc">
        插件自身的数据与密钥存储、壳内界面、插件设置、主题和声明式功能入口由 eNest 统一提供，无需单独授权。
        这些能力不包含访问系统文件、剪贴板或网络。
      </p>
    </div>
  )
}
