import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detailFrom, messageForStatus, parseVerification, retryAfterMs } from '../src/api'
import { INITIAL_BACKOFF_MS } from '../src/constants'
import { inferVulnId, parseApiUrl, parseInputs, readEvent } from '../src/inputs'
import { conclusionForVerdict, verdictFailsJob } from '../src/report'
import type { EventPayload, FailOn, Verdict } from '../src/types'
import { joinApi } from '../src/urls'

test('joinApi keeps the origin and a single path', () => {
  assert.equal(
    joinApi('http://127.0.0.1:9', '/api/v1/fix-verifications'),
    'http://127.0.0.1:9/api/v1/fix-verifications',
  )
})

test('parseApiUrl accepts the default origin and loopback, and rejects the rest', () => {
  assert.equal(parseApiUrl(''), 'https://settlebridge.ai')
  assert.equal(parseApiUrl('https://settlebridge.ai/'), 'https://settlebridge.ai')
  assert.equal(parseApiUrl('http://127.0.0.1:9'), 'http://127.0.0.1:9')
  assert.throws(() => parseApiUrl('http://example.com'), /https/)
  assert.throws(() => parseApiUrl('https://settlebridge.ai/api'), /without a path/)
  assert.throws(() => parseApiUrl('https://user:secret@settlebridge.ai'), /username or password/)
  assert.throws(() => parseApiUrl('https://settlebridge.ai?q=1'), /query string/)
})

test('inferVulnId uses one advisory id and rejects zero or many', () => {
  assert.equal(inferVulnId('Bump demo', 'Fixes GHSA-abcd-efgh-ijkl'), 'ghsa-abcd-efgh-ijkl')
  assert.equal(
    inferVulnId('ghsa-abcd-efgh-ijkl', 'also GHSA-abcd-efgh-ijkl'),
    'ghsa-abcd-efgh-ijkl',
  )
  assert.equal(inferVulnId('', 'pysec-2024-12'), 'PYSEC-2024-12')
  assert.throws(() => inferVulnId('no advisory here', ''), /vuln-id is required/)
  assert.throws(
    () => inferVulnId('', 'CVE-2024-1111 and CVE-2024-2222'),
    /more than one advisory id: CVE-2024-1111, CVE-2024-2222/,
  )
})

test('retryAfterMs honors delta seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('7', 0), 7_000)
  assert.equal(retryAfterMs(' 7 ', 0), 7_000)
  const now = Date.parse('Wed, 11 Nov 2026 12:00:00 GMT')
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 12:00:07 GMT', now), 7_000)
  assert.equal(retryAfterMs(null, now), null)
  assert.equal(retryAfterMs('not-a-date', now), null)
})

test('backoff constant stays the documented starting wait', () => {
  assert.equal(INITIAL_BACKOFF_MS, 2_000)
})

test('verdict failure threshold matches fail-on', () => {
  const verdicts: Verdict[] = ['verified', 'incomplete_fix_confirmed', 'inconclusive']
  const settings: FailOn[] = ['never', 'incomplete', 'inconclusive']
  const failures = new Set<string>([
    'incomplete:incomplete_fix_confirmed',
    'inconclusive:incomplete_fix_confirmed',
    'inconclusive:inconclusive',
  ])
  for (const failOn of settings) {
    for (const verdict of verdicts) {
      const fails = verdictFailsJob(failOn, verdict)
      assert.equal(fails, failures.has(`${failOn}:${verdict}`), `${failOn} ${verdict}`)
      if (verdict === 'verified') assert.equal(conclusionForVerdict(failOn, verdict), 'success')
      else assert.equal(conclusionForVerdict(failOn, verdict), fails ? 'failure' : 'neutral')
    }
  }
})

test('status messages name opt-in, a disabled feature, and an unlinked pull request', () => {
  assert.match(messageForStatus(403, null, 'create'), /not opted in to SettleBridge fix verification/)
  assert.match(messageForStatus(404, 'nope', 'create'), /disabled on this SettleBridge API/)
  assert.match(messageForStatus(404, 'nope', 'create'), /nope/)
  assert.match(messageForStatus(422, null, 'create'), /not linked to a security advisory/)
  assert.equal(detailFrom('<html>nope</html>'), null)
  assert.equal(detailFrom(JSON.stringify({ detail: 'PR 41 is not linked' })), 'PR 41 is not linked')
})

test('parseVerification rejects an unknown verdict', () => {
  assert.throws(
    () =>
      parseVerification({
        id: 'vf_123',
        state: 'done',
        verdict: 'secure',
        inconclusive_reason: null,
        receipt_id: null,
      }),
    /unexpected verdict/,
  )
})

test('parseInputs reads SHAs from the pull request when the inputs are empty', () => {
  const event: EventPayload = {
    pullRequest: {
      number: 8,
      title: 'Fix GHSA-abcd-efgh-ijkl',
      body: '',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
  }
  const parsed = parseInputs(
    (name) => (name === 'package' ? 'demo-pkg' : ''),
    event,
    { owner: 'octo', repo: 'demo' },
  )
  assert.equal(parsed.baseSha, 'a'.repeat(40))
  assert.equal(parsed.fixSha, 'b'.repeat(40))
  assert.equal(parsed.vulnId, 'ghsa-abcd-efgh-ijkl')
  assert.equal(parsed.pr, 8)
  assert.equal(parsed.failOn, 'incomplete')
  assert.equal(parsed.uploadReceipt, true)
  assert.equal(parsed.timeoutMinutes, 30)
  assert.equal(parsed.apiUrl, 'https://settlebridge.ai')
  assert.equal(parsed.alertRef, null)
})

test('readEvent copies the pull request fields used by the action', () => {
  const event = readEvent({
    number: 8,
    pull_request: {
      number: 8,
      title: 'Fix',
      body: null,
      base: { sha: 'a'.repeat(40) },
      head: { sha: 'b'.repeat(40) },
    },
  })
  assert.equal(event.pullRequest?.body, '')
  assert.equal(event.pullRequest?.baseSha, 'a'.repeat(40))
  assert.equal(event.number, 8)
})
