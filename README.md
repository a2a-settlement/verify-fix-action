# Verify security fix

GitHub Action that asks [SettleBridge](https://settlebridge.ai) to verify a pull request that fixes a security advisory. It publishes the verdict as a check run on the fix commit and, when SettleBridge has issued one, uploads the signed receipt as a workflow artifact.

This repository is a thin client. The verdict is the API's. Nothing here decides whether a fix holds.

## What it does

On a pull request it:

1. Requests a GitHub Actions OIDC token for the audience `settlebridge` (`core.getIDToken('settlebridge')`). On the runner that exchanges `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which GitHub sets only when the job has `id-token: write`.
2. `POST`s `{api-url}/api/v1/fix-verifications` with `Authorization: Bearer <token>`.
3. Polls `GET /api/v1/fix-verifications/{id}` until the state is `done` or `failed`, the timeout elapses, or SettleBridge returns `429`. A `429` waits for the `Retry-After` value (seconds, or an HTTP date) and then retries. Other waits use exponential backoff starting at 2 seconds and capping at 30 seconds.
4. Updates a check run named **SettleBridge fix verification** on the fix SHA with the verdict and a link to `{api-url}/api/v1/fix-verifications/{id}`.
5. When `upload-receipt` is true and the receipt endpoint returns a bundle, uploads that response body unchanged as the artifact `settlebridge-fix-receipt` (`receipt.json`). A `404` on the receipt means it is not available yet; the action warns and continues.

The token is marked as a GitHub Actions secret so the log masks it. The action refuses HTTP redirects, so the bearer token is not forwarded to another host. `http://` is accepted only for `127.0.0.1` and `localhost`.

## What it does not do

- It does not contain a verifier, a solver, a prompt, or a corpus. It does not inspect the diff.
- It does not merge the pull request, dismiss a GitHub alert, or decide that the project is secure.
- It does not show embargoed details of an incomplete fix. Those stay on SettleBridge, visible to the repository owner. This action never receives them.
- It does not check the receipt signature. That is the `verify-receipt` CLI in the `proof-of-fix-spec` repository.
- It does not send `GITHUB_TOKEN` to SettleBridge. That token is used only to create the check run.

## Scope

Pure-Python packages on PyPI. Every request sets `advisory.ecosystem` to `PyPI`. The action does not claim to cover wheels with native code, other ecosystems, or a pull request SettleBridge cannot link to the advisory (the API returns HTTP 422 for that).

`advisory.summary` and `advisory.details` are sent empty. `aliases` is sent as an empty list. SettleBridge already has the advisory; this action does not copy the pull request body in as the advisory text.

## Permissions

Set these on the job that runs the action:

| Permission | Why |
| --- | --- |
| `id-token: write` | Lets the runner mint an OIDC token. The audience is fixed: `settlebridge`. |
| `checks: write` | Creates and updates the check run. |
| `contents: read` | Required together with the two permissions above. The action does not read repository files. |

GitHub does not give `id-token: write` to workflows triggered by a pull request from a fork. Run this action on pull requests that originate in the opted-in repository. Do not switch the trigger to `pull_request_target` to work around that. That trigger runs with the base repository's permissions.

## Usage

```yaml
name: Verify fix
on:
  pull_request:

permissions:
  id-token: write
  checks: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Verify the advisory fix
        id: verify
        uses: a2a-settlement/verify-fix-action@v1
        with:
          package: example-py
          vuln-id: GHSA-xxxx-xxxx-xxxx
          # alert-ref: "42"          # optional Dependabot or advisory alert reference
          # timeout-minutes: "30"    # maximum 360
          # fail-on: incomplete      # incomplete | inconclusive | never
          # upload-receipt: "true"

      - name: Record the verdict
        if: always()
        run: |
          echo "verdict=${{ steps.verify.outputs.verdict }}"
          echo "reason=${{ steps.verify.outputs.inconclusive-reason }}"
          echo "verification=${{ steps.verify.outputs.verification-id }}"
          echo "receipt=${{ steps.verify.outputs.receipt-id }}"
```

Replace `OWNER` with the GitHub owner of this action, and pin `@v1` to a commit SHA when you want a fixed build.

`vuln-id` may be omitted when the pull request title or body contains exactly one `GHSA-xxxx-xxxx-xxxx`, `CVE-YYYY-NNNN`, or `PYSEC-YYYY-N` id. If it contains more than one, set `vuln-id`. An explicit `vuln-id` is sent as-is; other ids mentioned in the pull request are not added to `aliases`.

`base-sha` and `fix-sha` default to `pull_request.base.sha` and `pull_request.head.sha`. The workflow must be a pull request event so the API receives a pull request number. The check run is attached to the fix SHA.

`api-url` defaults to `https://settlebridge.ai` and must be that origin, with no path, query, fragment, or userinfo.

## Inputs

| Input | Required | Default |
| --- | --- | --- |
| `api-url` | no | `https://settlebridge.ai` |
| `vuln-id` | unless one id can be inferred | |
| `package` | yes | |
| `alert-ref` | no | empty, sent as JSON `null` |
| `base-sha` | no | pull request base SHA |
| `fix-sha` | no | pull request head SHA |
| `timeout-minutes` | no | `30` (maximum `360`) |
| `fail-on` | no | `incomplete` |
| `upload-receipt` | no | `true` |

## Outputs

| Output | Meaning |
| --- | --- |
| `verdict` | `verified`, `incomplete_fix_confirmed`, `inconclusive`, or empty when there is no verdict |
| `inconclusive-reason` | Reason string from the API, when it sent one |
| `receipt-id` | Receipt id, when SettleBridge issued one |
| `verification-id` | Id returned by the create call |

## Verdicts and `fail-on`

| Verdict | What the check says | `fail-on: incomplete` (default) | `fail-on: inconclusive` | `fail-on: never` |
| --- | --- | --- | --- | --- |
| `verified` | No failure found under the frozen contract. | success | success | success |
| `incomplete_fix_confirmed` | The fix is incomplete. Details are embargoed and visible to the repo owner on SettleBridge. | fail | fail | neutral, job stays green |
| `inconclusive` | The `inconclusive_reason` from the API | neutral, job stays green | fail | neutral, job stays green |

`fail-on` applies to verdicts. These still fail the job and the check: the repository is not opted in (HTTP 403), the feature is disabled (HTTP 404 on create), the pull request is not linked to an advisory (HTTP 422), the verification state is `failed`, the wait exceeds `timeout-minutes`, the OIDC token cannot be issued, or the rate limit cannot be honored before the timeout. A receipt `404` does not fail the job. A receipt download that fails for another reason does.

The check conclusion uses the same verdict rule as the job. `success` is used only for `verified` when the receipt upload, if requested and available, succeeded. A reported verdict that does not fail the job is `neutral`, so it is not presented as `verified`.

## Honesty rules

- **`verified` is not "proven secure."** The sentence this action displays for that verdict is only: "No failure found under the frozen contract."
- **`incomplete_fix_confirmed`** means the fix is incomplete. The failing case and the embargoed details are visible to the repository owner on SettleBridge. This action does not print them and does not have them.
- **`inconclusive`** means the check did not decide. The action shows the reason. It is not a passing result and it is not a confirmed incomplete fix.
- **A house-solver receipt does not claim independence.** If the bundle was produced by SettleBridge's own solver, it is SettleBridge's result. It is not an independent third-party review. This action does not describe any receipt as independent, and it does not rewrite the bundle.
- A green check is not a substitute for checking the signature yourself.

## Quota and cost

- Default quota: **20 verifications per day per installation** (the installation that connected the repository to SettleBridge).
- SettleBridge also rate-limits each repository. HTTP 429 carries `Retry-After`. This action waits and retries. It does not treat the first 429 as a verdict.
- Each accepted request uses one verification. The sample workflow runs on every update to the pull request, and overlapping runs each count.
- Expected cost: this action does not move funds and does not add a fee of its own. The job consumes GitHub Actions minutes while it polls, up to `timeout-minutes` (default 30, maximum 360, which is also the hosted-runner job limit). This repository does not encode a per-verification price. When the daily quota or the per-repository rate limit is exhausted, SettleBridge responds with HTTP 429 instead of billing an overage through this action.

## Receipt artifact

`receipt.json` is the raw body of `GET /api/v1/fix-verifications/{id}/receipt`: `receipt_id` and `bundle`. It is not re-serialized. If the endpoint returns 404, nothing is uploaded and the log says the receipt is not available yet.

## Verify a receipt offline

Download the `settlebridge-fix-receipt` artifact from the workflow run. Check the file on a machine you control with the `verify-receipt` CLI from the `proof-of-fix-spec` repository. Install that CLI from that repository's own instructions, then:

```bash
verify-receipt receipt.json
```

That CLI checks the signed bundle in the file you have. It is not part of this action, and a signature check does not need to call SettleBridge. If `proof-of-fix-spec` documents extra required arguments, such as a trust anchor or the frozen contract, pass those. Follow that repository if the command differs.

`verify-receipt` tells you the bundle is intact and signed. It does not turn a house-solver result into a third-party one, and it does not mean the change has been proven secure. Do not paste the receipt into an untrusted service to "check" it.

## Development

The runner executes `dist/index.js` (Node 20). Source is TypeScript, bundled with `@vercel/ncc`. Runtime dependencies are `@actions/core`, `@actions/github`, and `@actions/artifact`.

```bash
npm ci
npm test
npm run lint
npm run build
```

Commit `dist/` after `npm run build`. CI runs lint (ESLint and `tsc`), the tests, a rebuild, and `git diff --exit-code -- dist`.

Tests use Node's test runner and a local HTTP server. They do not call SettleBridge or GitHub.
