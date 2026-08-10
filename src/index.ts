import { DurableObject } from 'cloudflare:workers'

export interface Env {
  ROOM: DurableObjectNamespace
  TOKEN_SECRET: string
}

export class Room extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    return new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
