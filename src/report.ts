import { INCOMPLETE_SENTENCE, VERIFIED_SENTENCE } from './constants'
import type { CheckConclusion, FailOn, Verification, Verdict } from './types'
import { verificationUrl } from './urls'

export interface CheckText {
  title: string
  summary: string
  text: string
}

export interface FinishedCheck extends CheckText {
  conclusion: CheckConclusion
}

export interface ReportContext {
  apiUrl: string
  repo: string
  pr?: number
  packageName?: string
  vulnId?: string
  baseSha?: string
  fixSha?: string
  verificationId?: string
}

/**
 * fail-on is a threshold. `never` does not fail the job for a verdict.
 * `incomplete` fails when the fix is incomplete. `inconclusive` also fails
 * when the verdict is inconclusive. `verified` does not fail the job.
 */
export function verdictFailsJob(failOn: FailOn, verdict: Verdict): boolean {
  if (verdict === 'verified' || failOn === 'never') return false
  if (verdict === 'incomplete_fix_confirmed') return true
  return failOn === 'inconclusive'
}

export function conclusionForVerdict(failOn: FailOn, verdict: Verdict): 'success' | 'failure' | 'neutral' {
  if (verdict === 'verified') return 'success'
  return verdictFailsJob(failOn, verdict) ? 'failure' : 'neutral'
}

export function jobFailureMessage(failOn: FailOn, verification: Verification): string | null {
  if (verification.state === 'failed') {
    const reason = verification.inconclusiveReason
    return reason
      ? `SettleBridge reported the verification as failed. ${reason}`
      : 'SettleBridge reported the verification as failed.'
  }
  if (!verification.verdict || !verdictFailsJob(failOn, verification.verdict)) return null
  if (verification.verdict === 'incomplete_fix_confirmed') {
    return `SettleBridge verdict: incomplete_fix_confirmed. ${INCOMPLETE_SENTENCE}`
  }
  const reason = verification.inconclusiveReason ?? 'SettleBridge did not provide a reason.'
  return `SettleBridge verdict: inconclusive. ${reason}`
}

function fence(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``
}

function code(value: string): string {
  return `\`${value.replace(/`/g, '')}\``
}

function linkBlock(apiUrl: string, id: string): string {
  const url = verificationUrl(apiUrl, id)
  return `[View this verification on SettleBridge](${url})\n\n${url}`
}

function contextTable(context: ReportContext): string {
  const rows: string[] = []
  const add = (label: string, value: string | undefined): void => {
    if (!value) return
    rows.push(`| ${label} | ${code(value)} |`)
  }
  add('Repository', context.repo)
  if (context.pr !== undefined) add('Pull request', `#${context.pr}`)
  add('Package', context.packageName)
  if (context.packageName) add('Ecosystem', 'PyPI')
  add('Advisory', context.vulnId)
  add('Base SHA', context.baseSha)
  add('Fix SHA', context.fixSha)
  if (rows.length === 0) return ''
  return ['| | |', '| --- | --- |', ...rows].join('\n')
}

function verdictSentence(verification: Verification): string {
  if (verification.verdict === 'verified') return VERIFIED_SENTENCE
  if (verification.verdict === 'incomplete_fix_confirmed') return INCOMPLETE_SENTENCE
  if (!verification.inconclusiveReason) {
    return 'SettleBridge returned an inconclusive verdict without a reason.'
  }
  return `SettleBridge could not decide.\n\n${fence(verification.inconclusiveReason)}`
}

function titleFor(verdict: Verdict): string {
  if (verdict === 'verified') return VERIFIED_SENTENCE
  if (verdict === 'incomplete_fix_confirmed') return 'Incomplete fix'
  return 'Inconclusive'
}

export function renderRunning(context: ReportContext): CheckText {
  const lines = ['Asking SettleBridge to verify this pull request.']
  if (context.verificationId && context.apiUrl) {
    lines.push('', linkBlock(context.apiUrl, context.verificationId), '', 'Waiting for a verdict.')
  }
  return {
    title: 'Verifying security fix',
    summary: lines.join('\n'),
    text: contextTable(context) || 'Waiting for SettleBridge.',
  }
}

export function renderVerdict(options: {
  context: ReportContext
  verification: Verification
  failOn: FailOn
  receiptNote?: string
  uploadError?: string
}): FinishedCheck {
  const { verification } = options
  if (verification.state === 'failed' || !verification.verdict) {
    return renderFailure({
      message: jobFailureMessage(options.failOn, verification) ?? 'SettleBridge reported the verification as failed.',
      timedOut: false,
      context: { ...options.context, verificationId: verification.id },
    })
  }
  const sentence = verdictSentence(verification)
  const summary = [
    `**Verdict:** ${code(verification.verdict)}`,
    '',
    sentence,
    '',
    linkBlock(options.context.apiUrl, verification.id),
  ]
  if (verification.receiptId) summary.push('', `**Receipt:** ${code(verification.receiptId)}`)
  if (options.receiptNote) summary.push('', options.receiptNote)
  if (options.uploadError) summary.push('', options.uploadError)
  const text = [contextTable({ ...options.context, verificationId: verification.id }), '', sentence]
    .filter((part) => part !== '')
    .join('\n')
  return {
    title: options.uploadError ? 'Verification finished but the receipt was not uploaded' : titleFor(verification.verdict),
    summary: summary.join('\n'),
    text,
    conclusion: options.uploadError ? 'failure' : conclusionForVerdict(options.failOn, verification.verdict),
  }
}

export function renderFailure(options: {
  message: string
  timedOut: boolean
  context: ReportContext
}): FinishedCheck {
  const summary = [options.message]
  if (options.context.apiUrl && options.context.verificationId) {
    summary.push('', linkBlock(options.context.apiUrl, options.context.verificationId))
  }
  const table = contextTable(options.context)
  return {
    title: options.timedOut ? 'Verification timed out' : 'Verification failed',
    summary: summary.join('\n'),
    text: table ? `${table}\n\n${options.message}` : options.message,
    conclusion: options.timedOut ? 'timed_out' : 'failure',
  }
}
