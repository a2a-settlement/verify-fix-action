export function joinApi(apiUrl: string, path: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
  const relative = path.startsWith('/') ? path.slice(1) : path
  return new URL(relative, base).toString()
}

export function verificationUrl(apiUrl: string, id: string): string {
  return joinApi(apiUrl, `/api/v1/fix-verifications/${encodeURIComponent(id)}`)
}

export function receiptUrl(apiUrl: string, id: string): string {
  return joinApi(apiUrl, `/api/v1/fix-verifications/${encodeURIComponent(id)}/receipt`)
}
