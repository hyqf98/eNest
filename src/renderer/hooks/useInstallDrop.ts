/**
 * useInstallDrop — 窗口级拖拽安装 hook
 * 职责：监听 window 的 dragenter/dragover/dragleave/drop，
 *       阻止浏览器默认导航；将 File 经 webUtils 转为绝对路径后调用 shellApi.installPlugin。
 * 为什么挂在 window 而非某个子节点：拖拽可能从任意区域进入，漏掉子节点边界会导致遮罩闪烁。
 * 被 ShellLayout 挂载。
 * 依赖：shellApi.getPathForFile / installPlugin。
 */
import { useEffect, useRef, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'

export interface UseInstallDropResult {
  /** 是否正在拖入文件（用于显示全窗遮罩） */
  dragging: boolean
}

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  // DOMStringList / readonly string[] 兼容
  return Array.from(types as ArrayLike<string>).includes('Files')
}

/** File → 绝对路径：优先 preload webUtils，兜底 file.path（旧 Electron） */
function filePathOf(file: File): string {
  const viaApi = shellApi.getPathForFile?.(file)
  if (viaApi) return viaApi
  const legacy = (file as File & { path?: string }).path
  return typeof legacy === 'string' ? legacy : ''
}

export function useInstallDrop(): UseInstallDropResult {
  const [dragging, setDragging] = useState(false)
  // dragenter/leave 在子元素间会成对触发，用计数器避免遮罩闪烁
  const counter = useRef(0)

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      counter.current += 1
      setDragging(true)
    }

    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      // 必须 preventDefault，否则 drop 不会触发
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      counter.current = Math.max(0, counter.current - 1)
      if (counter.current === 0) setDragging(false)
    }

    const onDrop = (e: DragEvent): void => {
      // 始终阻止默认打开/导航行为
      e.preventDefault()
      counter.current = 0
      setDragging(false)
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      for (let i = 0; i < files.length; i++) {
        const path = filePathOf(files[i])
        if (!path) continue
        // 失败结果统一走主进程 install-result → toast
        void shellApi.installPlugin(path).catch(() => {
          /* toast handled by shell event */
        })
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return { dragging }
}
