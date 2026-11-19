/** A failed request, carrying whatever JSON the server sent with it. */
export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

function errorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    // the new backend says `detail`, DocAssist says `message`
    const { detail, message } = body as { detail?: unknown; message?: unknown }
    if (typeof detail === 'string') return detail
    // a refused field: FastAPI lists what is wrong with each one
    if (Array.isArray(detail) && detail[0]?.msg) return `${detail[0].loc?.at(-1) ?? 'Field'}: ${detail[0].msg}`
    if (typeof message === 'string') return message
  }
  return 'Something went wrong. Try again.'
}

/** JSON in, JSON out; throws ApiError on any non-2xx reply. */
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      // DocAssist answers JSON instead of a login redirect only when it sees this
      'X-Requested-With': 'XMLHttpRequest',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(errorMessage(data), response.status, data)
  return data as T
}

/** A DocAssist call that may answer 200 with a flag instead of an error code: the flag says whether it worked. */
export async function contract<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const reply = await api<T & { ok?: boolean; status?: string; message?: string }>(path, method, body)
  if (reply.ok === false || reply.status === 'error') throw new Error(reply.message || 'Could not do that. Try again.')
  return reply
}

/** Where DocAssist runs, for its own pages this app links to (not for requests: those go through the dev proxy). */
export const DOCASSIST_URL: string = import.meta.env.VITE_DOCASSIST_URL ?? 'http://localhost:5002'
