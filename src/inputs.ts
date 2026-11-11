import { MAX_TIMEOUT_MINUTES } from './constants'
import type { EventPayload, FailOn, ParsedInputs } from './types'

const SHA = /^[0-9a-f]{40}$/
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/
const ADVISORY_ID =
  /\b(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,}|PYSEC-\d{4}-\d+)(?![0-9a-z-])/gi

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function readEvent(payload: { number?: unknown; pull_request?: unknown }): EventPayload {
  const number = typeof payload.number === 'number' ? payload.number : undefined
  const pull = asRecord(payload.pull_request)
  if (!pull) return { number }
  const base = asRecord(pull.base)
  const head = asRecord(pull.head)
  return {
    number,
    pullRequest: {
      number: typeof pull.number === 'number' ? pull.number : undefined,
      title: typeof pull.title === 'string' ? pull.title : '',
      body: typeof pull.body === 'string' ? pull.body : '',
      baseSha: base && typeof base.sha === 'string' ? base.sha : '',
      headSha: head && typeof head.sha === 'string' ? head.sha : '',
    },
  }
}

function canonicalizeAdvisoryId(value: string): string {
  const upper = value.toUpperCase()
  if (upper.startsWith('GHSA-')) return value.toLowerCase()
  if (upper.startsWith('CVE-') || upper.startsWith('PYSEC-')) return upper
  return value
}

export function inferVulnId(title: string, body: string): string {
  const found = new Map<string, string>()
  for (const match of `${title}\n${body}`.matchAll(ADVISORY_ID)) {
    const canonical = canonicalizeAdvisoryId(match[1] ?? '')
    if (canonical) found.set(canonical, canonical)
  }
  if (found.size === 0) {
    throw new Error(
      'Input vuln-id is required. No GHSA, CVE, or PYSEC id was found in the pull request title or body.',
    )
  }
  if (found.size > 1) {
    const ids = [...found.keys()].sort().join(', ')
    throw new Error(
      `Input vuln-id is required. The pull request mentions more than one advisory id: ${ids}.`,
    )
  }
  const [only] = [...found.keys()]
  if (!only) {
    throw new Error('Input vuln-id is required. No advisory id could be inferred.')
  }
  return only
}

export function parseApiUrl(raw: string): string {
  const text = raw.trim() === '' ? 'https://settlebridge.ai' : raw.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('Input api-url must be an absolute URL, for example https://settlebridge.ai.')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('Input api-url must use https. http is only allowed for 127.0.0.1 and localhost.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Input api-url must use https.')
  }
  if (url.username || url.password) {
    throw new Error('Input api-url must not include a username or password.')
  }
  if (url.search || url.hash) {
    throw new Error('Input api-url must not include a query string or fragment.')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      'Input api-url must be the SettleBridge origin without a path, for example https://settlebridge.ai.',
    )
  }
  return url.origin
}

function parseBoolean(name: string, raw: string, fallback: boolean): boolean {
  if (raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Input ${name} must be true or false.`)
}

function parseFailOn(raw: string): FailOn {
  const value = (raw.trim() === '' ? 'incomplete' : raw.trim()).toLowerCase()
  if (value === 'incomplete' || value === 'inconclusive' || value === 'never') return value
  throw new Error('Input fail-on must be incomplete, inconclusive, or never.')
}

function parseTimeoutMinutes(raw: string): number {
  const text = raw.trim() === '' ? '30' : raw.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('Input timeout-minutes must be a non-negative number of minutes.')
  }
  const minutes = Number(text)
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(`Input timeout-minutes must be between 0 and ${MAX_TIMEOUT_MINUTES}.`)
  }
  return minutes
}

function requireSha(label: 'base-sha' | 'fix-sha', explicit: string, fallback: string): string {
  const value = (explicit.trim() || fallback.trim()).toLowerCase()
  if (!SHA.test(value)) {
    throw new Error(
      `${label} must be a 40-character hex commit SHA. Set the input or run this action on a pull_request event.`,
    )
  }
  return value
}

function requirePackage(raw: string): string {
  const value = raw.trim()
  if (!PACKAGE_NAME.test(value)) {
    throw new Error('Input package is required and must be a PyPI package name.')
  }
  return value
}

function isUnsafeToken(value: string): boolean {
  if (/[\s`|]/.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

function requireVulnId(explicit: string, event: EventPayload): string {
  const given = explicit.trim()
  if (given) {
    if (given.length > 200 || isUnsafeToken(given)) {
      throw new Error('Input vuln-id must be a single advisory id without whitespace.')
    }
    return given
  }
  return inferVulnId(event.pullRequest?.title ?? '', event.pullRequest?.body ?? '')
}

function parseAlertRef(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.length > 300 || isUnsafeToken(value)) {
    throw new Error('Input alert-ref must be a single reference without control characters.')
  }
  return value
}

function requirePullRequestNumber(event: EventPayload): number {
  const value = event.pullRequest?.number ?? event.number
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      'This action must run on a pull request. No pull request number was found in the workflow event.',
    )
  }
  return value
}

export function parseInputs(
  getInput: (name: string) => string,
  event: EventPayload,
  repository: { owner: string; repo: string },
): ParsedInputs {
  if (
    !repository.owner ||
    !repository.repo ||
    /[\s/]/.test(repository.owner) ||
    /[\s/]/.test(repository.repo)
  ) {
    throw new Error('Could not determine owner/name for this repository.')
  }
  const timeoutMinutes = parseTimeoutMinutes(getInput('timeout-minutes'))
  return {
    apiUrl: parseApiUrl(getInput('api-url')),
    vulnId: requireVulnId(getInput('vuln-id'), event),
    packageName: requirePackage(getInput('package')),
    alertRef: parseAlertRef(getInput('alert-ref')),
    baseSha: requireSha('base-sha', getInput('base-sha'), event.pullRequest?.baseSha ?? ''),
    fixSha: requireSha('fix-sha', getInput('fix-sha'), event.pullRequest?.headSha ?? ''),
    pr: requirePullRequestNumber(event),
    repo: `${repository.owner}/${repository.repo}`,
    timeoutMinutes,
    timeoutMs: Math.round(timeoutMinutes * 60_000),
    failOn: parseFailOn(getInput('fail-on')),
    uploadReceipt: parseBoolean('upload-receipt', getInput('upload-receipt'), true),
  }
}
