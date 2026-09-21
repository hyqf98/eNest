/**
 * electron.vite.config — 构建配置
 * 别名：@main → src/main，@preload → src/preload，@renderer → src/renderer，@shared → src/shared
 * 与 tsconfig.node.json / tsconfig.web.json 的 paths 保持一致。
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: {
          index: r('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
