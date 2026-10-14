/** 驱动注册表 + kinds.list 描述符派生。仅运行于 mwUtility。
 * 四个驱动文件由各适配器实现，静态能力声明汇总为 MwDriverDescriptor。 */
import type { MwDriverDescriptor, MwKind } from '@shared/types/mw-workbench'
import type { MwDriver } from '@main/middleware/types'
import { kafkaDriver } from '@main/middleware/drivers/kafka'
import { rabbitmqDriver } from '@main/middleware/drivers/rabbitmq'
import { mqttDriver } from '@main/middleware/drivers/mqtt'
import { rocketmqDriver } from '@main/middleware/drivers/rocketmq'

export const MW_DRIVER_REGISTRY: Record<MwKind, MwDriver> = {
  kafka: kafkaDriver,
  rabbitmq: rabbitmqDriver,
  mqtt: mqttDriver,
  rocketmq: rocketmqDriver
}

export function getMwDriver(kind: string): MwDriver {
  const driver = MW_DRIVER_REGISTRY[kind as MwKind]
  if (!driver) throw new Error(`unknown middleware kind: ${kind}`)
  return driver
}

export function mwDriverDescriptors(): MwDriverDescriptor[] {
  return Object.values(MW_DRIVER_REGISTRY).map(driver => ({
    kind: driver.kind,
    label: driver.label,
    transport: driver.transport,
    defaultPort: driver.defaultPort,
    messageQueryModes: driver.messageQueryModes,
    capabilities: driver.capabilities
  }))
}
