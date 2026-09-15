const MAX_INJECTION_DETAIL_LENGTH = 600

function cleanTrustedText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INJECTION_DETAIL_LENGTH)
}

/** Builds the only text shape that a copilot tool result may inject into GPT Live. */
export function buildCopilotInjection(toolId: string, trustedModelText: string): string | undefined {
  const detail = cleanTrustedText(trustedModelText)
  if (!detail || detail === 'NO_ACTION') return undefined
  const safeToolId = toolId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'unknown'
  return `System note: tool ${safeToolId} completed. ${detail}`
}

export function truncateModelText(text: string): string {
  return cleanTrustedText(text)
}
