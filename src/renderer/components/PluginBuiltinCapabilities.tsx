/** Built-in, plugin-scoped services are available without a consent decision. */
export function PluginBuiltinCapabilities() {
  return (
    <div className="plugin-builtin-capabilities">
      <h3 className="label">基础能力 <span>直接可用</span></h3>
      <p className="desc">
        插件自身的数据与密钥存储、壳内界面、插件设置、主题、功能入口和后台计时直接可用。
        文件读写由你选择文件或保存位置时授权，无需重复确认；网络、剪贴板等权限可在下方单独管理。
      </p>
    </div>
  )
}
