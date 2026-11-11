export type VerificationState = 'queued' | 'running' | 'done' | 'failed'
export type Verdict = 'verified' | 'incomplete_fix_confirmed' | 'inconclusive'
export type FailOn = 'incomplete' | 'inconclusive' | 'never'
export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'timed_out'

export interface Verification {
  id: string
  state: VerificationState
  verdict: Verdict | null
  inconclusiveReason: string | null
  receiptId: string | null
}

export interface AdvisoryBody {
  vuln_id: string
  aliases: string[]
  summary: string
  details: string
  package: string
  ecosystem: 'PyPI'
}

export interface CreateBody {
  repo: string
  pr: number
  base_sha: string
  fix_sha: string
  advisory: AdvisoryBody
  alert_ref: string | null
}

export interface PullRequestEvent {
  number?: number
  title: string
  body: string
  baseSha: string
  headSha: string
}

export interface EventPayload {
  number?: number
  pullRequest?: PullRequestEvent
}

export interface ParsedInputs {
  apiUrl: string
  vulnId: string
  packageName: string
  alertRef: string | null
  baseSha: string
  fixSha: string
  pr: number
  repo: string
  timeoutMinutes: number
  timeoutMs: number
  failOn: FailOn
  uploadReceipt: boolean
}

export interface CheckOutput {
  title: string
  summary: string
  text: string
}

export interface CheckDraft {
  owner: string
  repo: string
  name: string
  head_sha: string
  output: CheckOutput
}

export interface CheckProgress {
  owner: string
  repo: string
  check_run_id: number
  details_url: string
  output: CheckOutput
}

export interface CheckComplete {
  owner: string
  repo: string
  check_run_id: number
  conclusion: CheckConclusion
  details_url?: string
  output: CheckOutput
}

export interface CheckClient {
  create(input: CheckDraft): Promise<{ id: number }>
  progress(input: CheckProgress): Promise<void>
  complete(input: CheckComplete): Promise<void>
}

export interface Logger {
  info(message: string): void
  warning(message: string): void
  setFailed(message: string): void
  setOutput(name: string, value: string): void
}

export interface ActionRequestInit extends RequestInit {
  cache?: 'no-store'
}

export interface Dependencies {
  getInput(name: string): string
  getIDToken(audience: string): Promise<string>
  maskSecret(value: string): void
  githubToken: string
  event: EventPayload
  repo: { owner: string; repo: string }
  fetch(url: string, init: ActionRequestInit): Promise<Response>
  sleep(ms: number): Promise<void>
  now(): number
  logger: Logger
  checks: CheckClient
  uploadArtifact(name: string, files: string[], rootDirectory: string): Promise<void>
  writeSummary(markdown: string): Promise<void>
}
