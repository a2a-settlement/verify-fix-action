export function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return 'SettleBridge fix verification failed.'
}

export class VerificationTimeout extends Error {
  constructor(id: string, timeoutMinutes: number, lastState: string) {
    const unit = timeoutMinutes === 1 ? 'minute' : 'minutes'
    super(
      `Timed out after ${timeoutMinutes} ${unit} waiting for SettleBridge verification ${id} (last state: ${lastState}).`,
    )
    this.name = 'VerificationTimeout'
  }
}
