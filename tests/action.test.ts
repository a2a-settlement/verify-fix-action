import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHECK_NAME, INCOMPLETE_SENTENCE, VERIFIED_SENTENCE } from '../src/constants'
import type { EventPayload } from '../src/types'
import { runCase, type CaseResult } from './harness'
import type { Handler, RecordedRequest } from './server'

const FIX = '2'.repeat(40)
const RECEIPT = '{"receipt_id":"rcpt_123","bundle":{"solver":"house","statement":"fixture"}}'
const REASON = 'The frozen tests could not be executed.'

function verification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vf_123',
    state: 'done',
    verdict: 'verified',
    inconclusive_reason: null,
    receipt_id: 'rcpt_123',
    ...overrides,
  }
}

function assertNoOverclaim(result: CaseResult): void {
  const text = [
    ...result.infos,
    ...result.warnings,
    ...result.failed,
    ...result.summaries,
    ...result.completed.map((check) => `${check.output.summary}\n${check.output.text}`),
  ].join('\n')
  assert.doesNotMatch(text, /proven secure/i)
  assert.doesNotMatch(text, /\bindependent\b/i)
  assert.doesNotMatch(text, /oidc-test-token/)
  assert.doesNotMatch(text, /ghs_test_github_token/)
}

function postedBody(requests: RecordedRequest[]): Record<string, unknown> {
  const post = requests.find((request) => request.method === 'POST')
  assert.ok(post, 'expected a POST')
  return JSON.parse(post.body) as Record<string, unknown>
}

test('happy path verified posts the contract, polls with backoff, and uploads the raw receipt', async () => {
  let gets = 0
  const result = await runCase({
    handler: (request) => {
      if (request.method === 'POST') {
        return { status: 201, body: verification({ state: 'queued', verdict: null, receipt_id: null }) }
      }
      if (request.path.endsWith('/receipt')) return { status: 200, raw: RECEIPT }
      gets += 1
      if (gets === 1) {
        return { status: 200, body: verification({ state: 'running', verdict: null, receipt_id: null }) }
      }
      return { status: 200, body: verification({ state: 'done', verdict: 'verified', receipt_id: 'rcpt_123' }) }
    },
  })

  assert.deepEqual(result.sleeps, [2_000, 4_000])
  assert.deepEqual(result.audiences, ['settlebridge'])
  assert.deepEqual(result.masked, ['oidc-test-token'])
  assert.deepEqual(result.failed, [])
  assert.equal(result.outputs.verdict, 'verified')
  assert.equal(result.outputs['inconclusive-reason'], '')
  assert.equal(result.outputs['receipt-id'], 'rcpt_123')
  assert.equal(result.outputs['verification-id'], 'vf_123')
  assert.equal(result.created[0]?.name, CHECK_NAME)
  assert.equal(result.created[0]?.head_sha, FIX)
  assert.equal(result.completed[0]?.conclusion, 'success')
  assert.match(result.completed[0]?.output.summary ?? '', new RegExp(VERIFIED_SENTENCE))
  assert.match(result.completed[0]?.output.summary ?? '', /\/api\/v1\/fix-verifications\/vf_123/)
  assert.match(result.summaries.join('\n'), new RegExp(VERIFIED_SENTENCE))
  assertNoOverclaim(result)

  for (const request of result.requests) {
    assert.equal(request.authorization, 'Bearer oidc-test-token')
    assert.notEqual(request.authorization, 'Bearer ghs_test_github_token')
  }
  const body = postedBody(result.requests)
  const advisory = body.advisory as Record<string, unknown>
  assert.equal(body.repo, 'octo/demo')
  assert.equal(body.pr, 41)
  assert.equal(body.base_sha, '1'.repeat(40))
  assert.equal(body.fix_sha, FIX)
  assert.equal(body.alert_ref, null)
  assert.equal(advisory.vuln_id, 'GHSA-1111-2222-3333')
  assert.deepEqual(advisory.aliases, [])
  assert.equal(advisory.summary, '')
  assert.equal(advisory.details, '')
  assert.equal(advisory.package, 'demo-pkg')
  assert.equal(advisory.ecosystem, 'PyPI')
  assert.equal(result.uploads.length, 1)
  assert.equal(result.uploads[0]?.name, 'settlebridge-fix-receipt')
  assert.deepEqual(Object.values(result.uploads[0]?.contents ?? {}), [RECEIPT])
  const post = result.requests.find((request) => request.method === 'POST')
  assert.match(post?.contentType ?? '', /application\/json/)
})

test('incomplete fix fails the job when fail-on is incomplete', async () => {
  const result = await runCase({
    inputs: { 'upload-receipt': 'false' },
    handler: (request) => {
      assert.equal(request.method, 'POST')
      return {
        status: 201,
        body: verification({
          state: 'done',
          verdict: 'incomplete_fix_confirmed',
          inconclusive_reason: null,
          receipt_id: null,
        }),
      }
    },
  })
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0] ?? '', /incomplete_fix_confirmed/)
  assert.match(result.failed[0] ?? '', new RegExp(INCOMPLETE_SENTENCE.replace(/[.]/g, '\\.')))
  assert.equal(result.completed[0]?.conclusion, 'failure')
  assert.match(result.completed[0]?.output.summary ?? '', /embargoed/)
  assert.equal(result.outputs.verdict, 'incomplete_fix_confirmed')
  assert.equal(result.uploads.length, 0)
  assertNoOverclaim(result)
})

test('inconclusive reason is surfaced and does not fail the default job', async () => {
  const result = await runCase({
    inputs: { 'upload-receipt': 'false' },
    handler: () => ({
      status: 201,
      body: verification({
        state: 'done',
        verdict: 'inconclusive',
        inconclusive_reason: REASON,
        receipt_id: null,
      }),
    }),
  })
  assert.deepEqual(result.failed, [])
  assert.equal(result.outputs.verdict, 'inconclusive')
  assert.equal(result.outputs['inconclusive-reason'], REASON)
  assert.equal(result.completed[0]?.conclusion, 'neutral')
  assert.match(result.completed[0]?.output.summary ?? '', new RegExp(REASON))
  assert.match(result.warnings.join('\n'), new RegExp(REASON))
  assertNoOverclaim(result)
})

test('fail-on inconclusive fails the job and fail-on never does not', async () => {
  const done = (verdict: string): Handler => () => ({
    status: 201,
    body: verification({
      state: 'done',
      verdict,
      inconclusive_reason: verdict === 'inconclusive' ? REASON : null,
      receipt_id: null,
    }),
  })
  const inconclusive = await runCase({
    inputs: { 'fail-on': 'inconclusive', 'upload-receipt': 'false' },
    handler: done('inconclusive'),
  })
  assert.equal(inconclusive.failed.length, 1)
  assert.match(inconclusive.failed[0] ?? '', new RegExp(REASON))
  assert.equal(inconclusive.completed[0]?.conclusion, 'failure')

  const never = await runCase({
    inputs: { 'fail-on': 'never', 'upload-receipt': 'false' },
    handler: done('incomplete_fix_confirmed'),
  })
  assert.deepEqual(never.failed, [])
  assert.equal(never.completed[0]?.conclusion, 'neutral')
  assert.match(never.completed[0]?.output.summary ?? '', /embargoed/)
})

test('honors Retry-After on 429 during polling', async () => {
  let gets = 0
  const result = await runCase({
    inputs: { 'upload-receipt': 'false' },
    handler: (request) => {
      if (request.method === 'POST') {
        return { status: 201, body: verification({ state: 'queued', verdict: null, receipt_id: null }) }
      }
      gets += 1
      if (gets === 1) {
        return { status: 429, headers: { 'retry-after': '7' }, body: { detail: 'slow down' } }
      }
      return { status: 200, body: verification({ state: 'done', verdict: 'verified', receipt_id: null }) }
    },
  })
  assert.deepEqual(result.sleeps, [2_000, 7_000])
  assert.equal(gets, 2)
  assert.deepEqual(result.failed, [])
  assert.equal(result.completed[0]?.conclusion, 'success')
  assert.match(result.infos.join('\n'), /429/)
})

test('HTTP 403 says the repository is not opted in', async () => {
  const result = await runCase({
    handler: () => ({ status: 403, body: { detail: 'not enrolled' } }),
  })
  assert.equal(result.requests.length, 1)
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0] ?? '', /not opted in to SettleBridge fix verification/)
  assert.match(result.failed[0] ?? '', /not enrolled/)
  assert.equal(result.completed[0]?.conclusion, 'failure')
  assert.equal(result.uploads.length, 0)
  assert.equal(result.progress.length, 0)
})

test('HTTP 404 says fix verification is disabled', async () => {
  const result = await runCase({
    handler: () => ({ status: 404, body: { detail: 'feature off' } }),
  })
  assert.match(result.failed[0] ?? '', /disabled on this SettleBridge API/)
  assert.match(result.failed[0] ?? '', /feature off/)
  assert.equal(result.completed[0]?.conclusion, 'failure')
})

test('HTTP 422 says the pull request is not linked to an advisory', async () => {
  const result = await runCase({
    handler: () => ({ status: 422, body: { detail: 'PR 41 is not linked' } }),
  })
  assert.match(result.failed[0] ?? '', /not linked to a security advisory/)
  assert.match(result.failed[0] ?? '', /PR 41 is not linked/)
  assert.equal(result.completed[0]?.conclusion, 'failure')
})

test('timeout stops polling and marks the check timed out', async () => {
  let clock = 0
  let gets = 0
  const result = await runCase({
    timeoutMinutes: '1',
    now: () => clock,
    onSleep: (ms) => {
      clock += ms
    },
    handler: (request) => {
      if (request.method === 'POST') {
        return { status: 201, body: verification({ state: 'queued', verdict: null, receipt_id: null }) }
      }
      gets += 1
      return { status: 200, body: verification({ state: 'running', verdict: null, receipt_id: null }) }
    },
  })
  assert.match(result.failed[0] ?? '', /Timed out after 1 minute waiting for SettleBridge verification vf_123/)
  assert.match(result.failed[0] ?? '', /last state: running/)
  assert.equal(result.completed.at(-1)?.conclusion, 'timed_out')
  assert.ok(gets >= 1)
  assert.ok(gets < 20)
  assert.equal(result.requests.some((request) => request.path.endsWith('/receipt')), false)
  assert.equal(result.outputs['verification-id'], 'vf_123')
})

test('receipt upload is skipped when the receipt is absent', async () => {
  const result = await runCase({
    handler: (request) => {
      if (request.method === 'POST') {
        return {
          status: 201,
          body: verification({ state: 'done', verdict: 'verified', receipt_id: null }),
        }
      }
      assert.match(request.path, /\/receipt$/)
      return { status: 404, body: { detail: 'not ready' } }
    },
  })
  assert.deepEqual(result.failed, [])
  assert.equal(result.uploads.length, 0)
  assert.equal(result.outputs.verdict, 'verified')
  assert.equal(result.outputs['receipt-id'], '')
  assert.match(result.warnings.join('\n'), /Signed receipt is not available yet/)
  assert.equal(result.completed[0]?.conclusion, 'success')
  assert.equal(result.requests.filter((request) => request.path.endsWith('/receipt')).length, 1)
})

test('upload-receipt false does not request a receipt', async () => {
  const result = await runCase({
    inputs: { 'upload-receipt': 'false' },
    handler: (request) => {
      assert.equal(request.method, 'POST')
      return { status: 201, body: verification({ state: 'done', verdict: 'verified', receipt_id: 'rcpt_123' }) }
    },
  })
  assert.deepEqual(result.failed, [])
  assert.equal(result.uploads.length, 0)
  assert.equal(result.outputs['receipt-id'], 'rcpt_123')
  assert.equal(result.requests.some((request) => request.path.endsWith('/receipt')), false)
})

test('a single advisory id is inferred from the pull request', async () => {
  const event: EventPayload = {
    number: 41,
    pullRequest: {
      number: 41,
      title: 'Bump demo-pkg',
      body: 'Fixes GHSA-abcd-efgh-ijkl and mentions ghsa-abcd-efgh-ijkl again.',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
  }
  const result = await runCase({
    event,
    inputs: { 'vuln-id': '', 'upload-receipt': 'false' },
    handler: () => ({
      status: 201,
      body: verification({ state: 'done', verdict: 'verified', receipt_id: null }),
    }),
  })
  const advisory = postedBody(result.requests).advisory as Record<string, unknown>
  assert.equal(advisory.vuln_id, 'ghsa-abcd-efgh-ijkl')
  assert.deepEqual(result.failed, [])
})

test('ambiguous advisory ids fail before SettleBridge is called', async () => {
  const event: EventPayload = {
    number: 41,
    pullRequest: {
      number: 41,
      title: 'fixes',
      body: 'CVE-2024-1111 and CVE-2024-2222',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
  }
  const result = await runCase({
    event,
    inputs: { 'vuln-id': '' },
  })
  assert.match(result.failed[0] ?? '', /more than one advisory id/)
  assert.equal(result.requests.length, 0)
  assert.equal(result.audiences.length, 0)
  assert.equal(result.created.length, 0)
})

test('verification state failed fails the job without uploading a receipt', async () => {
  const result = await runCase({
    handler: (request) => {
      assert.equal(request.method, 'POST')
      return {
        status: 201,
        body: verification({
          state: 'failed',
          verdict: null,
          inconclusive_reason: 'runner error',
          receipt_id: null,
        }),
      }
    },
  })
  assert.equal(result.requests.length, 1)
  assert.match(result.failed[0] ?? '', /reported the verification as failed/)
  assert.match(result.failed[0] ?? '', /runner error/)
  assert.equal(result.completed[0]?.conclusion, 'failure')
  assert.equal(result.outputs.verdict, '')
  assert.equal(result.outputs['inconclusive-reason'], 'runner error')
  assert.equal(result.uploads.length, 0)
})

test('redirects are not followed with the OIDC token', async () => {
  const result = await runCase({
    handler: (request) => {
      if (request.path !== '/api/v1/fix-verifications') {
        return { status: 500, body: { detail: `followed redirect to ${request.path}` } }
      }
      return { status: 302, headers: { location: '/stolen' }, raw: '' }
    },
  })
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0] ?? '', /redirect|HTTP 302/)
  assert.deepEqual(
    result.requests.map((request) => request.path),
    ['/api/v1/fix-verifications'],
  )
  assert.doesNotMatch(result.failed[0] ?? '', /oidc-test-token/)
})

test('a missing OIDC token fails the check before calling SettleBridge', async () => {
  const result = await runCase({
    getIDToken: () => Promise.reject(new Error('ACTIONS_ID_TOKEN_REQUEST_URL is not set')),
  })
  assert.match(result.failed[0] ?? '', /OIDC token/)
  assert.match(result.failed[0] ?? '', /id-token: write/)
  assert.equal(result.requests.length, 0)
  assert.equal(result.completed[0]?.conclusion, 'failure')
  assert.equal(result.masked.length, 0)
})

test('a missing GITHUB_TOKEN fails before any network call', async () => {
  const result = await runCase({ githubToken: '  ' })
  assert.match(result.failed[0] ?? '', /GITHUB_TOKEN is required/)
  assert.equal(result.requests.length, 0)
  assert.equal(result.created.length, 0)
})
