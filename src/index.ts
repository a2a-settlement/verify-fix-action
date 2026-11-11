import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { formatError } from './errors'
import { readEvent } from './inputs'
import { run } from './main'
import type { CheckOutput } from './types'

const token = process.env.GITHUB_TOKEN ?? ''
const octokit = token.trim() ? github.getOctokit(token) : undefined
const artifacts = new DefaultArtifactClient()

function outputOf(output: CheckOutput): { title: string; summary: string; text: string } {
  return { title: output.title, summary: output.summary, text: output.text }
}

void (async () => {
  try {
    await run({
      getInput: (name) => core.getInput(name),
      getIDToken: (audience) => core.getIDToken(audience),
      maskSecret: (value) => {
        core.setSecret(value)
      },
      githubToken: token,
      event: readEvent(github.context.payload),
      repo: github.context.repo,
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((resolve) => {
        setTimeout(resolve, ms)
      }),
      now: () => Date.now(),
      logger: {
        info: (message) => {
          core.info(message)
        },
        warning: (message) => {
          core.warning(message)
        },
        setFailed: (message) => {
          core.setFailed(message)
        },
        setOutput: (name, value) => {
          core.setOutput(name, value)
        },
      },
      checks: {
        async create(input) {
          if (!octokit) throw new Error('GITHUB_TOKEN is required to publish the check run.')
          const response = await octokit.rest.checks.create({
            owner: input.owner,
            repo: input.repo,
            name: input.name,
            head_sha: input.head_sha,
            status: 'in_progress',
            output: outputOf(input.output),
          })
          return { id: response.data.id }
        },
        async progress(input) {
          if (!octokit) throw new Error('GITHUB_TOKEN is required to publish the check run.')
          await octokit.rest.checks.update({
            owner: input.owner,
            repo: input.repo,
            check_run_id: input.check_run_id,
            status: 'in_progress',
            details_url: input.details_url,
            output: outputOf(input.output),
          })
        },
        async complete(input) {
          if (!octokit) throw new Error('GITHUB_TOKEN is required to publish the check run.')
          await octokit.rest.checks.update({
            owner: input.owner,
            repo: input.repo,
            check_run_id: input.check_run_id,
            status: 'completed',
            conclusion: input.conclusion,
            ...(input.details_url ? { details_url: input.details_url } : {}),
            output: outputOf(input.output),
          })
        },
      },
      uploadArtifact: async (name, files, rootDirectory) => {
        await artifacts.uploadArtifact(name, files, rootDirectory)
      },
      writeSummary: async (markdown) => {
        core.summary.addRaw(markdown)
        await core.summary.write()
      },
    })
  } catch (error) {
    core.setFailed(formatError(error))
  }
})()
