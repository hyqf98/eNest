/**
 * electron.vite.config — 构建配置
 * 别名：@main → src/main，@preload → src/preload，@renderer → src/renderer，@shared → src/shared
 * 与 tsconfig.node.json / tsconfig.web.json 的 paths 保持一致。
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as buildVite, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const r = (...p: string[]) => resolve(process.cwd(), ...p)

/** main / preload / renderer 共用的路径别名 */
const sharedAlias = {
  '@main': r('src/main'),
  '@preload': r('src/preload'),
  '@renderer': r('src/renderer'),
  '@shared': r('src/shared')
}

/** 开发态 Vite 端口：避开 5173 等常用端口，减少与其它 vite/工具冲突 */
const DEV_RENDERER_PORT = 27319

/** Sandboxed windows only support a self-contained CommonJS preload. */
function sandboxedPreloads(): Plugin {
  const entries = ['shellPreload', 'pluginPreload', 'recorderPreload', 'regionOverlayPreload', 'pinPreload']
  return {
    name: 'enest:sandboxed-preloads',
    async generateBundle(_options, bundle) {
      // Multi-entry Rollup emits shared chunks that sandboxed require cannot load.
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
            moduleParsed(module) { if (!module.isExternal) watch(module.id) }
          }],
          build: {
            write: false,
            minify: false,
            target: 'node22',
            lib: { entry: r(`src/preload/${name}.ts`), formats: ['cjs'], fileName: () => `${name}.cjs` },
            rollupOptions: { external: ['electron'], output: { inlineDynamicImports: true } }
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

/** electron-vite 2's regex mistakes "rejects import" in a string for an import.
 * Prepending shims at a known boundary keeps utility bundles (including worker
 * source strings) valid. No dependency patch or regex-based insertion is needed. */
function safeMainEsmShims(): Plugin {
  return {
    name: 'enest:safe-main-esm-shims',
    configResolved(config) {
      Reflect.set(config, 'plugins', config.plugins.filter((plugin) => plugin.name !== 'vite:esm-shim'))
    },
    renderChunk(code, _chunk, output) {
      if (output.format !== 'es') return null
      return { code: `import { createRequire as __enestCreateRequire } from 'node:module';
const require = __enestCreateRequire(import.meta.url);
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
${code}`, map: null }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), safeMainEsmShims()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: {
          index: r('src/main/index.ts'),
          dbUtility: r('src/main/database/dbUtility.ts'),
          mwUtility: r('src/main/middleware/mwUtility.ts'),
          pluginInstallWorker: r('src/main/plugin/pluginInstallWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), sandboxedPreloads()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: {
          shellPreload: r('src/preload/shellPreload.ts'),
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
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),
          'orb-overlay': r('src/renderer/orb-overlay.html')
        }
      }
    }
  }
})
