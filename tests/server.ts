import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
  contentType: string | null
  body: string
}

export interface HandlerResult {
  status: number
  headers?: Record<string, string>
  body?: unknown
  raw?: string
}

export type Handler = (request: RecordedRequest) => HandlerResult

export interface TestServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, result: HandlerResult): void {
  const raw = result.raw ?? JSON.stringify(result.body ?? {})
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    ...result.headers,
  })
  response.end(raw)
}

export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request)
        const recorded: RecordedRequest = {
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : null,
          contentType: typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : null,
          body,
        }
        requests.push(recorded)
        send(response, handler(recorded))
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'fixture error'
        send(response, { status: 500, body: { detail } })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
