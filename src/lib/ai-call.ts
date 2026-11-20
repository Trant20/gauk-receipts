// The one place this app calls Claude from (the same helper GMC uses, kept as a copy because each app deploys on its own).
//
// - Which model a job uses comes from the ai_jobs table (API Spend, Models in GMC), never from code. Pass a job name,
//   never a model: any model in the request body is replaced.
// - Every call is logged to ai_calls with its site, job, model, tokens, web searches and cost, priced from ai_models.
//   This is the log the GMC Usage panel and the failure and credit alerts read. The per-customer log (token_usage, which
//   feeds Cost items) is separate and stays with the routes that already write it.
// - If Anthropic refuses a call because the account is out of credit, the same flag the generator uses is set, and
//   the GMC status bar shows it.
// - Newer models (Sonnet 5.5 so far) think before they answer and the thinking counts toward max_tokens, so every call
//   gets room for it on top of the limit the route asks for. They also refuse a forced tool choice: when that happens
//   the call is repeated with the tool offered and not forced, and a model that then answers in text is asked to submit
//   through the tool. That changes only how the answer is handed back, never the prompt.
//
// Logging and the credit flag never break the call.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const CREDIT_FLAG_KEY = 'ai_credit_empty'
export const THINKING_HEADROOM = 8000
export const MAX_TOKENS_NOTE = 'Stopped at the max_tokens limit, so the answer was cut off'
const CACHE_MS = 30_000
const MAX_NUDGES = 2

/** The usage block Anthropic returns with every response. */
export interface AiUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

/** The Supabase client the route already has (service role). Only .from() is used. */
export interface AiDb { from(table: string): any }

interface Price { input: number, output: number, search: number }

const state = { jobs: new Map<string, string>(), prices: new Map<string, Price>(), at: 0 }
const noForcedTool = new Set<string>() // models that refused a forced tool choice, learned from the API's own answer

/** Drops the cached job and price tables (tests, and after a change that must show at once). */
export function resetAiCall(): void {
  state.jobs.clear(); state.prices.clear(); state.at = 0; noForcedTool.clear()
}

// ---------------------------------------------------------------- jobs and prices

async function load(db: AiDb): Promise<void> {
  const now = Date.now()
  if (state.jobs.size > 0 && now - state.at < CACHE_MS) return
  try {
    const [jobs, models] = await Promise.all([
      db.from('ai_jobs').select('job_key, model_id'),
      db.from('ai_models').select('model_id, input_per_mtok, output_per_mtok, search_per_1k'),
    ])
    if (jobs.error) throw new Error(jobs.error.message)
    if (models.error) throw new Error(models.error.message)
    state.jobs = new Map((jobs.data ?? []).map((r: Record<string, string>) => [r.job_key, r.model_id]))
    state.prices = new Map((models.data ?? []).map((r: Record<string, string>) => [
      r.model_id, { input: Number(r.input_per_mtok), output: Number(r.output_per_mtok), search: Number(r.search_per_1k) },
    ]))
    state.at = now
  } catch (e) {
    if (state.jobs.size > 0) {   // keep the last good copy rather than fail a customer's call over a read error
      console.error('Could not refresh the AI job table, using the last copy:', e instanceof Error ? e.message : e)
      state.at = now
      return
    }
    throw e
  }
}

/** The model a job uses. Throws when the job has no model, so a job never runs on a guessed one. */
export async function modelForJob(db: AiDb, job: string): Promise<string> {
  await load(db)
  const model = state.jobs.get(job)
  if (!model) throw new Error(`No model is set for the AI job '${job}'. Set one in GMC (Monitoring, API Spend, Models).`)
  return model
}

/** An exact match, else the longest table name the model starts with (dated names). null when it has no price. */
function priceOf(model: string): Price | null {
  const exact = state.prices.get(model)
  if (exact) return exact
  let best: string | null = null
  for (const id of state.prices.keys()) if (model.startsWith(id) && (best === null || id.length > best.length)) best = id
  return best ? state.prices.get(best)! : null
}

/** What one call cost, from the price table, or null when the model has no price (never guessed). */
export function costUsd(model: string, usage: AiUsage | null | undefined): number | null {
  const p = priceOf(model)
  if (!p || !usage) return null
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1_000_000 + searches * p.search / 1000
}

// ---------------------------------------------------------------- logging and the credit flag

/** Writes one ai_calls row. Never throws. */
export async function logAiCall(db: AiDb, args: {
  job: string, model: string, siteId?: string | null, usage?: AiUsage | null, error?: string | null
}): Promise<void> {
  try {
    const u = args.usage ?? null
    const { error } = await db.from('ai_calls').insert({
      site_id: args.siteId ?? null,
      job_key: args.job,
      model_id: args.model,
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      web_searches: u?.server_tool_use?.web_search_requests ?? 0,
      cost_usd: u ? costUsd(args.model, u) : null,
      ok: !args.error,
      error: args.error ? String(args.error).slice(0, 300) : null,
    })
    if (error) console.error('logAiCall failed:', error.message)
  } catch (e) {
    console.error('logAiCall failed:', e instanceof Error ? e.message : e)
  }
}

export function isCreditError(status: number, message: string): boolean {
  return status === 402 || /credit balance/i.test(message || '')
}

async function setCreditFlag(db: AiDb): Promise<void> {
  try {
    const { error } = await db.from('site_settings')
      .upsert({ site_id: null, key: CREDIT_FLAG_KEY, value: new Date().toISOString() }, { onConflict: 'site_id,key' })
    if (error) console.error('Could not set the credit flag:', error.message)
  } catch (e) {
    console.error('Could not set the credit flag:', e instanceof Error ? e.message : e)
  }
}

// ---------------------------------------------------------------- reading an answer

/** The written answer of a response: its text blocks joined, leaving out thinking and tool blocks. Newer models can
 *  start with a thinking block, so code must never read the answer as content[0].text. */
export function textOf(data: any): string {
  const blocks: any[] = Array.isArray(data?.content) ? data.content : []
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string' && b.text).map(b => b.text).join('\n').trim()
}

// ---------------------------------------------------------------- the call

export interface ClaudeCall {
  /** The AI job (a row in ai_jobs). Decides the model. */
  job: string
  apiKey: string
  /** The request body without model. max_tokens is the room the answer needs; room for thinking is added to it. */
  body: Record<string, any>
  siteId?: string | null
  signal?: AbortSignal
  /** false for a call that must stay as small as asked (the one-token health ping). */
  headroom?: boolean
  fetchImpl?: typeof fetch
}

export interface ClaudeResult {
  ok: boolean
  status: number
  /** The parsed response. When ok, data.usage is the total over every attempt the call needed. */
  data: any
  error: string | null
  model: string
}

function isForced(choice: any): boolean {
  return !!choice && typeof choice === 'object' && (choice.type === 'tool' || choice.type === 'any')
}

function refusesForced(message: string): boolean {
  const m = (message || '').toLowerCase()
  return m.includes('tool_choice') && (m.includes('not supported') || m.includes('does not support') || m.includes('not allowed'))
}

function calledTool(data: any, name: string | undefined): boolean {
  const blocks: any[] = Array.isArray(data?.content) ? data.content : []
  return blocks.some(b => b?.type === 'tool_use' && (!name || b.name === name))
}

function headers(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
}

function addUsage(total: AiUsage, part: any): void {
  if (!part) return
  total.input_tokens += part.input_tokens ?? 0
  total.output_tokens += part.output_tokens ?? 0
  total.cache_creation_input_tokens = (total.cache_creation_input_tokens ?? 0) + (part.cache_creation_input_tokens ?? 0)
  total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + (part.cache_read_input_tokens ?? 0)
  const searches = part.server_tool_use?.web_search_requests ?? 0
  if (searches) total.server_tool_use = { web_search_requests: (total.server_tool_use?.web_search_requests ?? 0) + searches }
}

async function errorMessage(res: Response | { status: number, json(): Promise<unknown> }, data?: any): Promise<string> {
  const d = data ?? await (res as Response).json().catch(() => ({}))
  return (d as any)?.error?.message || `Claude API error ${res.status}`
}

/** One non-streaming Claude call for a job. Returns the response whether it worked or not; throws only when the
 *  request itself could not be made (network error, timeout) or the job has no model. */
export async function callClaude(db: AiDb, call: ClaudeCall): Promise<ClaudeResult> {
  const doFetch = call.fetchImpl ?? fetch
  const model = await modelForJob(db, call.job)
  const body: Record<string, any> = { ...call.body, model, stream: false }
  if (call.headroom !== false && typeof body.max_tokens === 'number') body.max_tokens += THINKING_HEADROOM
  const forced = isForced(body.tool_choice) ? body.tool_choice : null
  const toolName: string | undefined = forced?.name
  if (forced && noForcedTool.has(model)) body.tool_choice = { type: 'auto' }

  const total: AiUsage = { input_tokens: 0, output_tokens: 0 }
  let nudges = 0
  for (;;) {
    let res: Response
    try {
      res = await doFetch(ANTHROPIC_API_URL, { method: 'POST', headers: headers(call.apiKey), body: JSON.stringify(body), signal: call.signal })
    } catch (e) {
      await logAiCall(db, { job: call.job, model, siteId: call.siteId, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = await errorMessage(res, data)
      if (forced && isForced(body.tool_choice) && refusesForced(message)) {
        noForcedTool.add(model)
        body.tool_choice = { type: 'auto' }
        continue
      }
      await logAiCall(db, { job: call.job, model, siteId: call.siteId, error: message })
      if (isCreditError(res.status, message)) await setCreditFlag(db)
      return { ok: false, status: res.status, data, error: message, model }
    }
    addUsage(total, data.usage)
    const cutOff = data.stop_reason === 'max_tokens'
    await logAiCall(db, { job: call.job, model, siteId: call.siteId, usage: data.usage, error: cutOff ? MAX_TOKENS_NOTE : null })
    if (forced && !isForced(body.tool_choice) && !calledTool(data, toolName) && nudges < MAX_NUDGES) {
      nudges++
      const what = toolName ? `the ${toolName} tool` : 'a tool'
      body.messages = [...(body.messages ?? []), { role: 'assistant', content: data.content }, { role: 'user', content: `Submit your answer by calling ${what}.` }]
      continue
    }
    data.usage = total
    return { ok: true, status: res.status, data, error: null, model }
  }
}
