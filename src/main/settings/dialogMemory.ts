/**
 * One remembered location for every file picker the settings surfaces open.
 *
 * Electron starts each dialog at the OS default (usually the home folder), so picking a second file
 * from the same place means navigating there again. This remembers the last folder a pick succeeded
 * in and offers it as the starting point next time, whatever entry point opened the picker.
 * It only chooses where the dialog opens: the returned paths carry no authorization, and every
 * caller keeps validating what it asked for.
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { settingsStore } from '@main/settings/SettingsStore'

/** The folder to open at, or undefined to leave the choice to the OS. */
function rememberedDirectory(): string | undefined {
  const value = settingsStore.getPickerDirectory()
  if (!value) return undefined
  // A folder that was moved or deleted since must not become an unusable start path.
  try { return statSync(value).isDirectory() ? value : undefined } catch { return undefined }
}

function rememberDirectory(directory: string): void {
  try {
    if (settingsStore.getPickerDirectory() !== directory) settingsStore.commitPickerDirectory(directory)
  } catch { /* Remembering is a convenience; never fail a completed pick over it. */ }
}

/** The folder a chosen path lives in. A directory choice is the directory itself. */
function folderOf(picked: string, directoryChoice: boolean): string {
  if (directoryChoice) return picked
  try { if (statSync(picked).isDirectory()) return picked } catch { /* fall through to the parent */ }
  return dirname(picked)
}

/**
 * `showOpenDialog` that starts at the last folder a pick succeeded in, and records the new one.
 * A caller-supplied `defaultPath` still wins: an entry point with a better guess keeps it.
 */
export async function openDialogWithMemory(options: OpenDialogOptions, parent?: BrowserWindow): Promise<string[]> {
  const directoryChoice = options.properties?.includes('openDirectory') === true
  const start = options.defaultPath || rememberedDirectory()
  const dialogOptions: OpenDialogOptions = start ? { ...options, defaultPath: start } : options
  const result = await trackNativeInteraction(parent
    ? dialog.showOpenDialog(parent, dialogOptions)
    : dialog.showOpenDialog(dialogOptions))
  // A cancelled dialog says nothing about where the user wants to be next time.
  if (result.canceled || !result.filePaths.length) return []
  rememberDirectory(folderOf(result.filePaths[0], directoryChoice))
  return result.filePaths
}
