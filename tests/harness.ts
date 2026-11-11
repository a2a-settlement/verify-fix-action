import { readFile } from 'node:fs/promises'
import { run } from '../src/main'
import type { CheckComplete, CheckDraft, CheckProgress, EventPayload } from '../src/types'
import { startServer, type Handler, type RecordedRequest } from './server'

export interface UploadRecord {
  name: string
  files: string[]
  rootDirectory: string
  contents: Record<string, string>
}

export interface CaseResult {
  requests: RecordedRequest[]
  sleeps: number[]
  failed: string[]
  warnings: string[]
  infos: string[]
  outputs: Record<string, string>
  summaries: string[]
  audiences: string[]
  masked: string[]
  created: CheckDraft[]
  progress: CheckProgress[]
  completed: CheckComplete[]
  uploads: UploadRecord[]
}

export interface CaseOptions {
  inputs?: Record<string, string>
  event?: EventPayload
  handler?: Handler
  githubToken?: string
  timeoutMinutes?: string
  onSleep?: (ms: number) => Promise<void> | void
  now?: () => number
  getIDToken?: (audience: string) => Promise<string>
}

const DEFAULT_EVENT: EventPayload = {
  number: 41,
  pullRequest: {
    number: 41,
    title: 'fix GHSA-9999-9999-9999',
    body: 'See GHSA-9999-9999-9999',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
}

export async function runCase(options: CaseOptions = {}): Promise<CaseResult> {
  const server = options.handler ? await startServer(options.handler) : undefined
  const result: CaseResult = {
    requests: server?.requests ?? [],
    sleeps: [],
    failed: [],
    warnings: [],
    infos: [],
    outputs: {},
    summaries: [],
    audiences: [],
    masked: [],
    created: [],
    progress: [],
    completed: [],
    uploads: [],
  }
  const inputs: Record<string, string> = {
    'api-url': server?.url ?? 'https://settlebridge.ai',
    'vuln-id': 'GHSA-1111-2222-3333',
    package: 'demo-pkg',
    'base-sha': '1'.repeat(40),
    'fix-sha': '2'.repeat(40),
    ...(options.timeoutMinutes === undefined ? {} : { 'timeout-minutes': options.timeoutMinutes }),
    ...options.inputs,
  }
  try {
    await run({
      getInput: (name) => inputs[name] ?? '',
      getIDToken: async (audience) => {
        result.audiences.push(audience)
        if (options.getIDToken) return options.getIDToken(audience)
        return 'oidc-test-token'
      },
      maskSecret: (value) => {
        result.masked.push(value)
      },
      githubToken: options.githubToken ?? 'ghs_test_github_token',
      event: options.event ?? DEFAULT_EVENT,
      repo: { owner: 'octo', repo: 'demo' },
      fetch: (url, init) => {
        if (!server) throw new Error(`unexpected fetch ${url}`)
        return fetch(url, init)
      },
      sleep: async (ms) => {
        result.sleeps.push(ms)
        await options.onSleep?.(ms)
      },
      now: options.now ?? (() => Date.now()),
      logger: {
        info: (message) => {
          result.infos.push(message)
        },
        warning: (message) => {
          result.warnings.push(message)
        },
        setFailed: (message) => {
          result.failed.push(message)
        },
        setOutput: (name, value) => {
          result.outputs[name] = value
        },
      },
      checks: {
        async create(input) {
          result.created.push(input)
          return { id: 100 }
        },
        async progress(input) {
          result.progress.push(input)
        },
        async complete(input) {
          result.completed.push(input)
        },
      },
      uploadArtifact: async (name, files, rootDirectory) => {
        const contents: Record<string, string> = {}
        for (const file of files) contents[file] = await readFile(file, 'utf8')
        result.uploads.push({ name, files, rootDirectory, contents })
      },
      writeSummary: async (markdown) => {
        result.summaries.push(markdown)
      },
    })
    return result
  } finally {
    await server?.close()
  }
}
