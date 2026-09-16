/**
 * launcher/types — 本地应用扫描共享类型
 */
export type { ApplicationScanResult, LocalApp } from '@shared/types/quick'

export interface AppScanner {
  scanApplications(): Promise<import('@shared/types/quick').ApplicationScanResult>
}
