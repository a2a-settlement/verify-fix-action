import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_HTTP_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
} from './constants'
import { VerificationTimeout, formatError } from './errors'
import type { Dependencies, Verification, VerificationState, Verdict } from './types'
import { receiptUrl, verificationUrl, joinApi } from './urls'

const STATES = new Set<VerificationState>(['queued', 'running', 'done', 'failed'])
const VERDICTS = new Set<Verdict>(['verified', 'incomplete_fix_confirmed', 'inconclusive'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

interface HttpResult {
  status: number
  text: string
}

export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null
  const value = header.trim()
  if (value === '') return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return null
    return Math.max(0, Math.ceil(seconds * 1000))
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return Math.max(0, parsed - now)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function detailFrom(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) return null
  for (const key of ['detail', 'message', 'error']) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const cleaned = value.replace(/\s+/g, ' ').trim()
    if (!cleaned || cleaned.length > 300 || cleaned.includes('<') || cleaned.includes('>')) continue
    return cleaned
  }
  return null
}

export function messageForStatus(
  status: number,
  detail: string | null,
  kind: 'create' | 'status' | 'receipt',
): string {
  let base: string
  if (status === 401) {
    base =
      'SettleBridge rejected the GitHub OIDC token. Grant id-token: write and confirm this repository is opted in.'
  } else if (status === 403) {
    base = 'This repository is not opted in to SettleBridge fix verification.'
  } else if (status === 404 && kind === 'create') {
    base = 'Fix verification is disabled on this SettleBridge API.'
  } else if (status === 404) {
    base = 'The SettleBridge verification was not found.'
  } else if (status === 422) {
    base = 'This pull request is not linked to a security advisory.'
  } else {
    base = `SettleBridge returned HTTP ${status}.`
  }
  if (!detail || base.includes(detail)) return base
  return `${base} ${detail}`
}

function parseJson(text: string): unknown {
  if (!text.trim()) throw new Error('SettleBridge returned an empty response.')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('SettleBridge returned a response that was not valid JSON.')
  }
}

function requireSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value.includes('..')) {
    throw new Error(`SettleBridge returned an unreadable ${label}.`)
  }
  return value
}

export function parseVerification(value: unknown): Verification {
  const record = asRecord(value)
  if (!record) throw new Error('SettleBridge returned a verification that was not a JSON object.')
  if (typeof record.id !== 'string') {
    throw new Error('SettleBridge verification response did not include an id.')
  }
  const id = requireSafeId(record.id, 'verification id')
  if (typeof record.state !== 'string' || !STATES.has(record.state as VerificationState)) {
    throw new Error('SettleBridge returned an unexpected verification state.')
  }
  let verdict: Verdict | null = null
  if (record.verdict !== null && record.verdict !== undefined) {
    if (typeof record.verdict !== 'string' || !VERDICTS.has(record.verdict as Verdict)) {
      throw new Error('SettleBridge returned an unexpected verdict.')
    }
    verdict = record.verdict as Verdict
  }
  let inconclusiveReason: string | null = null
  if (record.inconclusive_reason !== null && record.inconclusive_reason !== undefined) {
    if (typeof record.inconclusive_reason !== 'string') {
      throw new Error('SettleBridge returned an unreadable inconclusive_reason.')
    }
    const trimmed = record.inconclusive_reason.trim()
    inconclusiveReason = trimmed === '' ? null : trimmed.slice(0, 4_000)
  }
  let receiptId: string | null = null
  if (record.receipt_id !== null && record.receipt_id !== undefined) {
    if (typeof record.receipt_id !== 'string') {
      throw new Error('SettleBridge returned an unreadable receipt_id.')
    }
    if (record.receipt_id !== '') receiptId = requireSafeId(record.receipt_id, 'receipt id')
  }
  return {
    id,
    state: record.state as VerificationState,
    verdict,
    inconclusiveReason,
    receiptId,
  }
}

export interface ReceiptPayload {
  raw: string
  receiptId: string | null
}

export function parseReceipt(text: string): ReceiptPayload {
  const record = asRecord(parseJson(text))
  if (!record || !asRecord(record.bundle)) {
    throw new Error('SettleBridge receipt response did not include a bundle.')
  }
  let receiptId: string | null = null
  if (record.receipt_id !== null && record.receipt_id !== undefined && record.receipt_id !== '') {
    if (typeof record.receipt_id !== 'string') {
      throw new Error('SettleBridge receipt response included an unreadable receipt_id.')
    }
    receiptId = requireSafeId(record.receipt_id, 'receipt id')
  }
  return { raw: text, receiptId }
}

function networkMessage(url: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : 'network error'
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
  const name = error instanceof Error ? error.name : ''
  const combined = `${name} ${reason} ${cause}`
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout/i.test(combined)) {
    return `Could not reach SettleBridge at ${url}: the request timed out.`
  }
  if (/redirect/i.test(combined)) {
    return `SettleBridge redirected ${url}. The OIDC token was not sent to another host.`
  }
  return `Could not reach SettleBridge at ${url}: ${formatError(error)}`
}

function rateLimitMessage(waitMs: number, deadline: number, now: number, detail: string | null): string {
  const seconds = Math.ceil(waitMs / 1000)
  const base =
    now + waitMs > deadline
      ? `SettleBridge rate limited this repository (HTTP 429, Retry-After ${seconds}s), which exceeds the remaining timeout.`
      : 'SettleBridge rate limit persisted after retries (HTTP 429).'
  if (!detail || base.includes(detail)) return base
  return `${base} ${detail}`
}

export class SettleBridgeClient {
  constructor(
    private readonly deps: Pick<Dependencies, 'fetch' | 'sleep' | 'now' | 'logger'>,
    private readonly apiUrl: string,
  ) {}

  async create(body: unknown, token: string, deadline: number): Promise<Verification> {
    const url = joinApi(this.apiUrl, '/api/v1/fix-verifications')
    this.deps.logger.info(`POST ${url}`)
    const response = await this.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      token,
      deadline,
    )
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(messageForStatus(response.status, detailFrom(response.text), 'create'))
    }
    return parseVerification(parseJson(response.text))
  }

  async get(id: string, token: string, deadline: number): Promise<Verification> {
    const url = verificationUrl(this.apiUrl, id)
    this.deps.logger.info(`GET ${url}`)
    const response = await this.request(url, { method: 'GET' }, token, deadline)
    if (response.status !== 200) {
      throw new Error(messageForStatus(response.status, detailFrom(response.text), 'status'))
    }
    return parseVerification(parseJson(response.text))
  }

  async wait(
    initial: Verification,
    token: string,
    deadline: number,
    timeoutMinutes: number,
  ): Promise<Verification> {
    let current = initial
    let delay = INITIAL_BACKOFF_MS
    this.deps.logger.info(`Verification ${current.id} is ${current.state}.`)
    while (current.state === 'queued' || current.state === 'running') {
      if (this.deps.now() >= deadline) {
        throw new VerificationTimeout(current.id, timeoutMinutes, current.state)
      }
      const wait = Math.min(delay, deadline - this.deps.now())
      await this.deps.sleep(wait)
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
      current = await this.get(current.id, token, deadline)
      this.deps.logger.info(`Verification ${current.id} is ${current.state}.`)
    }
    return current
  }

  async getReceipt(
    id: string,
    token: string,
    deadline: number,
  ): Promise<{ kind: 'missing' } | ({ kind: 'ok' } & ReceiptPayload)> {
    const url = receiptUrl(this.apiUrl, id)
    this.deps.logger.info(`GET ${url}`)
    const response = await this.request(url, { method: 'GET' }, token, deadline)
    if (response.status === 404) return { kind: 'missing' }
    if (response.status !== 200) {
      throw new Error(messageForStatus(response.status, detailFrom(response.text), 'receipt'))
    }
    return { kind: 'ok', ...parseReceipt(response.text) }
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    token: string,
    deadline: number,
  ): Promise<HttpResult> {
    let delay = INITIAL_BACKOFF_MS
    for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt += 1) {
      let response: Response
      try {
        response = await this.deps.fetch(url, {
          method: init.method,
          body: init.body,
          headers: {
            accept: 'application/json',
            'user-agent': 'verify-fix-action',
            ...init.headers,
            authorization: `Bearer ${token}`,
          },
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        throw new Error(networkMessage(url, error))
      }
      if (response.status !== 429) {
        return { status: response.status, text: await response.text() }
      }
      const text = await response.text()
      const headerWait = retryAfterMs(response.headers.get('retry-after'), this.deps.now())
      const waitMs = headerWait ?? delay
      const detail = detailFrom(text)
      const lastAttempt = attempt === MAX_HTTP_ATTEMPTS - 1
      if (lastAttempt || this.deps.now() + waitMs > deadline) {
        throw new Error(rateLimitMessage(waitMs, deadline, this.deps.now(), detail))
      }
      this.deps.logger.info(
        `SettleBridge returned HTTP 429. Waiting ${waitMs / 1000} seconds before retrying.`,
      )
      await this.deps.sleep(waitMs)
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    }
    throw new Error('SettleBridge rate limit persisted after retries (HTTP 429).')
  }
}
