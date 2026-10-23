import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group

export function DropdownMenuContent({
  className = '', align = 'end', sideOffset = 6, children, onClick, onPointerDown, onKeyDown, ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={`ui-menu${className ? ` ${className}` : ''}`}
        {...props}
        onClick={(event) => { event.stopPropagation(); onClick?.(event) }}
        onPointerDown={(event) => { event.stopPropagation(); onPointerDown?.(event) }}
        onKeyDown={(event) => { event.stopPropagation(); onKeyDown?.(event) }}
      >
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className = '', danger = false, ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { danger?: boolean }) {
  return <MenuPrimitive.Item className={`ui-menu-item${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`} {...props} />
}

export function DropdownMenuCheckboxItem({
  className = '', checked, children, ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem checked={checked} className={`ui-menu-item${className ? ` ${className}` : ''}`} {...props}>
      <span className="ui-menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className="ui-menu-label">{children}</span>
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuLabel({ className = '', ...props }: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={`ui-menu-heading${className ? ` ${className}` : ''}`} {...props} />
}

export function DropdownMenuSeparator({ className = '', ...props }: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={`ui-menu-sep${className ? ` ${className}` : ''}`} {...props} />
}

export type MoreMenuItem = { sep: true } | {
  key: string
  label: ReactNode
  hint?: string
  hidden?: boolean
  disabled?: boolean
  danger?: boolean
  as?: 'check'
  checked?: boolean
  onSelect?: ComponentPropsWithoutRef<typeof MenuPrimitive.Item>['onSelect']
  onCheckedChange?: (checked: boolean) => void
}

type MoreMenuProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Root> & {
  label?: ReactNode
  ariaLabel?: string
  items: MoreMenuItem[]
  buttonClassName?: string
  disabled?: boolean
  triggerProps?: ComponentPropsWithoutRef<'button'>
}

export function MoreMenu({
  label = '⋯', ariaLabel = '更多操作', items, buttonClassName = '', disabled = false, triggerProps = {}, ...rootProps
}: MoreMenuProps) {
  return (
    <DropdownMenu modal={false} {...rootProps}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`btn ghost ui-more-trigger${buttonClassName ? ` ${buttonClassName}` : ''}`}
          aria-label={ariaLabel}
          title={ariaLabel}
          disabled={disabled}
          {...triggerProps}
          onClick={(event) => { event.stopPropagation(); triggerProps.onClick?.(event) }}
          onPointerDown={(event) => { event.stopPropagation(); triggerProps.onPointerDown?.(event) }}
          onKeyDown={(event) => { event.stopPropagation(); triggerProps.onKeyDown?.(event) }}
        >{label}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={ariaLabel}>
        {items.map((item, index) => {
          if ('sep' in item) return <DropdownMenuSeparator key={`sep-${index}`} />
          if (item.hidden) return null
          if (item.as === 'check') return (
            <DropdownMenuCheckboxItem key={item.key} checked={!!item.checked} disabled={item.disabled} onCheckedChange={item.onCheckedChange} onSelect={item.onSelect}>
              {item.label}
            </DropdownMenuCheckboxItem>
          )
          return (
            <DropdownMenuItem key={item.key} danger={item.danger} disabled={item.disabled} onSelect={item.onSelect}>
              <span className="ui-menu-check" aria-hidden="true" />
              <span className="ui-menu-label">{item.label}</span>
              {item.hint && <span className="ui-menu-hint">{item.hint}</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
