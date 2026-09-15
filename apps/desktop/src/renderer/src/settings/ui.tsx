import type { ReactNode } from 'react'

export type SettingsTone = 'neutral' | 'success' | 'warning' | 'danger'

export function SettingsCard(props: {
  title: string
  description: string
  children: ReactNode
  badge?: ReactNode
  actions?: ReactNode
  className?: string
  id?: string
  testId?: string
  titleId?: string
}): React.JSX.Element {
  const titleId = props.titleId ?? (props.id ? `${props.id}-title` : undefined)
  return (
    <section
      id={props.id}
      className={`settings-card${props.className ? ` ${props.className}` : ''}`}
      data-testid={props.testId}
      aria-labelledby={titleId}
    >
      <header className="settings-card__header">
        <div>
          <h3 id={titleId}>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        {(props.badge || props.actions) && (
          <div className="settings-card__header-actions">{props.badge}{props.actions}</div>
        )}
      </header>
      <div className="settings-card__body">{props.children}</div>
    </section>
  )
}

export function Field(props: {
  label: string
  children: ReactNode
  htmlFor?: string
  meta?: ReactNode
  help?: ReactNode
  error?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`settings-field${props.className ? ` ${props.className}` : ''}`}>
      <div className="settings-field__label-row">
        <label htmlFor={props.htmlFor}>{props.label}</label>
        {props.meta}
      </div>
      {props.children}
      {props.help && <div className="settings-field__help">{props.help}</div>}
      {props.error && <div className="settings-field__error">{props.error}</div>}
    </div>
  )
}

export function StatusBadge(props: {
  children: ReactNode
  tone?: SettingsTone
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <span data-testid={props.testId} className={`settings-badge settings-badge--${props.tone ?? 'neutral'}${props.className ? ` ${props.className}` : ''}`}>
      {props.children}
    </span>
  )
}

export function SegmentedControl<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; description?: string }>
  disabled?: boolean
  onChange(value: T): void
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={`settings-segments${props.className ? ` ${props.className}` : ''}`}
      role="radiogroup"
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
    >
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          className={props.value === option.value ? 'selected' : ''}
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
        >
          <strong>{option.label}</strong>
          {option.description && <small>{option.description}</small>}
        </button>
      ))}
    </div>
  )
}
