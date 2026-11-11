import { SettleBridgeClient } from './api'
import { ARTIFACT_NAME, CHECK_NAME, INCOMPLETE_SENTENCE, OIDC_AUDIENCE } from './constants'
import { VerificationTimeout, formatError } from './errors'
import { parseInputs } from './inputs'
import { writeReceipt } from './receipt'
import {
  jobFailureMessage,
  renderFailure,
  renderRunning,
  renderVerdict,
  type ReportContext,
} from './report'
import type { CheckOutput, Dependencies, Verification } from './types'
import { verificationUrl } from './urls'

interface Published {
  verificationId: string
  verdict: string
  inconclusiveReason: string
  receiptId: string
}

function blankPublished(): Published {
  return { verificationId: '', verdict: '', inconclusiveReason: '', receiptId: '' }
}

function applyVerification(published: Published, verification: Verification): void {
  published.verificationId = verification.id
  published.verdict = verification.verdict ?? ''
  published.inconclusiveReason = verification.inconclusiveReason ?? ''
  published.receiptId = verification.receiptId ?? ''
}

function publish(deps: Dependencies, published: Published): void {
  deps.logger.setOutput('verification-id', published.verificationId)
  deps.logger.setOutput('verdict', published.verdict)
  deps.logger.setOutput('inconclusive-reason', published.inconclusiveReason)
  deps.logger.setOutput('receipt-id', published.receiptId)
}

function toOutput(content: { title: string; summary: string; text: string }): CheckOutput {
  return { title: content.title, summary: content.summary, text: content.text }
}

async function safeSummary(deps: Dependencies, markdown: string): Promise<void> {
  try {
    await deps.writeSummary(markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  } catch (error) {
    deps.logger.warning(`Could not write the job summary. ${formatError(error)}`)
  }
}

export async function run(deps: Dependencies): Promise<void> {
  const published = blankPublished()
  let checkId: number | undefined
  let completed = false
  const repoSlug = `${deps.repo.owner}/${deps.repo.repo}`
  let context: ReportContext = { apiUrl: '', repo: repoSlug }

  const fail = async (error: unknown): Promise<void> => {
    const message = formatError(error)
    if (checkId !== undefined && !completed) {
      const content = renderFailure({
        message,
        timedOut: error instanceof VerificationTimeout,
        context,
      })
      try {
        await deps.checks.complete({
          owner: deps.repo.owner,
          repo: deps.repo.repo,
          check_run_id: checkId,
          conclusion: content.conclusion,
          ...(context.apiUrl && context.verificationId
            ? { details_url: verificationUrl(context.apiUrl, context.verificationId) }
            : {}),
          output: toOutput(content),
        })
        completed = true
      } catch (updateError) {
        deps.logger.warning(`Could not complete the check run. ${formatError(updateError)}`)
      }
    }
    publish(deps, published)
    await safeSummary(deps, message)
    deps.logger.setFailed(message)
  }

  try {
    if (!deps.githubToken.trim()) {
      throw new Error(
        'GITHUB_TOKEN is required to publish the check run. Grant checks: write and contents: read.',
      )
    }
    const input = parseInputs(deps.getInput, deps.event, deps.repo)
    context = {
      apiUrl: input.apiUrl,
      repo: input.repo,
      pr: input.pr,
      packageName: input.packageName,
      vulnId: input.vulnId,
      baseSha: input.baseSha,
      fixSha: input.fixSha,
    }
    const running = renderRunning(context)
    const createdCheck = await deps.checks.create({
      owner: deps.repo.owner,
      repo: deps.repo.repo,
      name: CHECK_NAME,
      head_sha: input.fixSha,
      output: toOutput(running),
    })
    checkId = createdCheck.id

    let token: string
    try {
      deps.logger.info(`Requesting a GitHub OIDC token for audience ${OIDC_AUDIENCE}.`)
      token = await deps.getIDToken(OIDC_AUDIENCE)
    } catch (error) {
      throw new Error(
        `Could not obtain a GitHub OIDC token for audience "${OIDC_AUDIENCE}". Grant id-token: write. ${formatError(error)}`,
      )
    }
    if (!token.trim()) {
      throw new Error(
        `GitHub returned an empty OIDC token for audience "${OIDC_AUDIENCE}". Grant id-token: write.`,
      )
    }
    deps.maskSecret(token)

    const deadline = deps.now() + input.timeoutMs
    const client = new SettleBridgeClient(deps, input.apiUrl)
    const created = await client.create(
      {
        repo: input.repo,
        pr: input.pr,
        base_sha: input.baseSha,
        fix_sha: input.fixSha,
        advisory: {
          vuln_id: input.vulnId,
          aliases: [],
          summary: '',
          details: '',
          package: input.packageName,
          ecosystem: 'PyPI',
        },
        alert_ref: input.alertRef,
      },
      token,
      deadline,
    )
    applyVerification(published, created)
    context = { ...context, verificationId: created.id }
    const waiting = renderRunning(context)
    await deps.checks.progress({
      owner: deps.repo.owner,
      repo: deps.repo.repo,
      check_run_id: checkId,
      details_url: verificationUrl(input.apiUrl, created.id),
      output: toOutput(waiting),
    })

    const verification = await client.wait(created, token, deadline, input.timeoutMinutes)
    applyVerification(published, verification)
    if (verification.state === 'done' && !verification.verdict) {
      throw new Error(`SettleBridge marked verification ${verification.id} done without a verdict.`)
    }

    let receiptNote: string | undefined
    let uploadError: string | undefined
    if (input.uploadReceipt && verification.state === 'done') {
      try {
        const receipt = await client.getReceipt(verification.id, token, deadline)
        if (receipt.kind === 'missing') {
          receiptNote = 'Signed receipt is not available yet. Skipping artifact upload.'
          deps.logger.warning(receiptNote)
        } else {
          if (receipt.receiptId) published.receiptId = receipt.receiptId
          const written = await writeReceipt(receipt.raw)
          await deps.uploadArtifact(ARTIFACT_NAME, [written.file], written.directory)
        }
      } catch (error) {
        uploadError = `Could not upload the signed receipt. ${formatError(error)}`
      }
    }

    const finished = renderVerdict({
      context,
      verification,
      failOn: input.failOn,
      receiptNote,
      uploadError,
    })
    await deps.checks.complete({
      owner: deps.repo.owner,
      repo: deps.repo.repo,
      check_run_id: checkId,
      conclusion: finished.conclusion,
      details_url: verificationUrl(input.apiUrl, verification.id),
      output: toOutput(finished),
    })
    completed = true
    publish(deps, published)
    await safeSummary(deps, `${finished.summary}\n\n${finished.text}`)

    if (verification.verdict === 'inconclusive' && !jobFailureMessage(input.failOn, verification)) {
      deps.logger.warning(
        verification.inconclusiveReason
          ? `Inconclusive: ${verification.inconclusiveReason}`
          : 'Inconclusive: SettleBridge did not provide a reason.',
      )
    }
    if (
      verification.verdict === 'incomplete_fix_confirmed' &&
      !jobFailureMessage(input.failOn, verification)
    ) {
      deps.logger.warning(`SettleBridge verdict: incomplete_fix_confirmed. ${INCOMPLETE_SENTENCE}`)
    }

    const reasons = [jobFailureMessage(input.failOn, verification), uploadError].filter(
      (item): item is string => Boolean(item),
    )
    if (reasons.length > 0) deps.logger.setFailed(reasons.join('\n'))
  } catch (error) {
    await fail(error)
  }
}
