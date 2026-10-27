/**
 * electron.vite.config — 构建配置
 * 别名：@main → src/main，@preload → src/preload，@renderer → src/renderer，@shared → src/shared，@test → tests
 * 与 tsconfig.node.json / tsconfig.web.json 的 paths 保持一致。
 */
import { defineConfig } from 'electron-vite'
import { build as buildVite, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const r = (...p: string[]) => resolve(process.cwd(), ...p)

/** main / preload / renderer 共用的路径别名 */
const sharedAlias = {
  '@main': r('src/main'),
  '@preload': r('src/preload'),
  '@renderer': r('src/renderer'),
  '@shared': r('src/shared'),
  '@test': r('tests')
}

/** 开发态 Vite 端口：避开 5173 等常用端口，减少与其它 vite/工具冲突 */
const DEV_RENDERER_PORT = 27319

/** Sandboxed windows only support a self-contained CommonJS preload. */
function sandboxedPreloads(production: boolean): Plugin {
  const entries = ['shellPreload', 'pluginPreload', 'backgroundPreload', 'auxiliaryPreload', 'detachedPluginPreload', 'installPreload', 'notificationPreload', 'homePreload', 'modalPreload', 'themeChromePreload', 'panelPreload', 'regionPreload']
  return {
    name: 'enest:sandboxed-preloads',
    async generateBundle(_options, bundle) {
      // Multi-entry bundling emits shared chunks that sandboxed require cannot load.
      for (const [name, file] of Object.entries(bundle)) if (file.type === 'chunk') delete bundle[name]
      for (const name of entries) {
        const watch = (id: string) => this.addWatchFile(id)
        const result = await buildVite({
          configFile: false,
          publicDir: false,
          logLevel: 'silent',
          resolve: { alias: sharedAlias },
          plugins: [{
            name: 'enest:watch-sandboxed-preload',
            moduleParsed(module) { if (!module.id.startsWith('\0')) watch(module.id) }
          }],
          build: {
            write: false,
            minify: production ? 'oxc' : false,
            target: 'node22',
            lib: { entry: r(`src/preload/${name}.ts`), formats: ['cjs'], fileName: () => `${name}.cjs` },
            rolldownOptions: { external: ['electron'], output: { codeSplitting: false } }
          }
        })
        for (const output of Array.isArray(result) ? result : [result]) {
          if (!('output' in output)) throw new Error(`Missing sandboxed preload output: ${name}`)
          for (const file of output.output) {
            this.emitFile({ type: 'asset', fileName: file.fileName, source: file.type === 'chunk' ? file.code : file.source })
          }
        }
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'ENEST_'), ...process.env }
  return {
  main: {
    define: {
      __ENEST_AUTH__: JSON.stringify({
        githubClientId: env.ENEST_GITHUB_CLIENT_ID || '',
        githubTokenExchangeUrl: env.ENEST_GITHUB_TOKEN_EXCHANGE_URL || '',
        githubDeviceFlow: env.ENEST_GITHUB_DEVICE_FLOW === '1',
      }),
    },
    // electron-vite 6 externalizes dependencies and injects AST-positioned ESM shims.
    resolve: {
      alias: sharedAlias
    },
    build: {
      minify: mode === 'production' ? 'oxc' : false,
      rolldownOptions: {
        input: {
          index: r('src/main/index.ts'),
          pluginInstallWorker: r('src/main/plugin/pluginInstallWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [sandboxedPreloads(mode === 'production')],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rolldownOptions: {
        input: {
          shellPreload: r('src/preload/shellPreload.ts'),
          detachedPluginPreload: r('src/preload/detachedPluginPreload.ts'),
          pluginPreload: r('src/preload/pluginPreload.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: sharedAlias
    },
    root: r('src/renderer'),
    server: {
      port: DEV_RENDERER_PORT,
      strictPort: true,
      host: '127.0.0.1'
    },
    build: {
      // The Electron preset disables minification unless explicitly enabled.
      minify: mode === 'production' ? 'oxc' : false,
      rolldownOptions: {
        input: {
          index: r('src/renderer/index.html'),
          quick: r('src/renderer/quick.html'),
          'orb-overlay': r('src/renderer/orb-overlay.html'),
          'install-overlay': r('src/renderer/install-overlay.html'),
          'detached-plugin': r('src/renderer/detached-plugin.html'),
          'notification-overlay': r('src/renderer/notification-overlay.html'),
          'home': r('src/renderer/home.html'),
          'modal-overlay': r('src/renderer/modal-overlay.html'),
          'panel': r('src/renderer/panel.html'),
          'region-overlay': r('src/renderer/region-overlay.html')
        }
      }
    }
  }
  }
})
