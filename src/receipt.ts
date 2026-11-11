import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function writeReceipt(raw: string): Promise<{ directory: string; file: string }> {
  const configured = process.env.RUNNER_TEMP?.trim()
  const root = configured ? configured : tmpdir()
  const directory = await mkdtemp(join(root, 'settlebridge-fix-receipt-'))
  const file = join(directory, 'receipt.json')
  await writeFile(file, raw, { encoding: 'utf8', flag: 'w' })
  return { directory, file }
}
