import type { SupabaseClient } from '@supabase/supabase-js'

// The one way a scan route spends a user's credit.
//
// spendCredits calls the database function spend_credits: it refuses an account on hold, checks the balance
// under a row lock, deducts and writes the ledger row in one transaction. A route calls it before any AI runs and,
// if it returns a Response, returns that Response as it is. A null means the spend went through.
// refundSpend gives back exactly what that one spend took, once. Both are keyed by a request id.

const SUPPORT_EMAIL = 'support@gaukmedia.com'
const ON_HOLD_MESSAGE = `Your account is on hold, so credits cannot be used right now. Please email ${SUPPORT_EMAIL} and we will help.`

interface SpendArgs {
  userId: string
  siteId: string
  amount: number
  reason: 'identification_used'
  requestId: string
  note?: string | null
}

const json = (data: unknown, status: number) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

export async function spendCredits(supabase: SupabaseClient, args: SpendArgs): Promise<Response | null> {
  const { userId, siteId, amount, reason, requestId } = args

  if (!Number.isInteger(amount) || amount <= 0) {
    console.error(`spendCredits: invalid amount ${amount} for ${reason}`)
    return json({ error: 'Something went wrong, please try again' }, 500)
  }

  const { data, error } = await supabase.rpc('spend_credits', {
    p_user_id: userId,
    p_site_id: siteId,
    p_amount: amount,
    p_reason: reason,
    p_note: args.note ?? null,
    p_request_id: requestId,
  })
  if (error) {
    console.error('spendCredits: spend_credits failed:', error.message)
    return json({ error: 'Something went wrong, please try again' }, 500)
  }

  if (data === 'ok') return null
  // Same reply the scan screens already understand for "no credits left"
  if (data === 'insufficient') return json({ error: 'Insufficient credits.', credits_exhausted: true }, 402)
  if (data === 'on_hold') return json({ error: ON_HOLD_MESSAGE, code: 'account_on_hold' }, 403)

  console.error('spendCredits: unexpected result', data)
  return json({ error: 'Something went wrong, please try again' }, 500)
}

// Never throws: a failed refund is logged loudly so it can be corrected by hand, and does not hide the original error.
export async function refundSpend(supabase: SupabaseClient, requestId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('refund_spend', { p_request_id: requestId })
    if (error) console.error(`[refund] REFUND FAILED for request ${requestId}: ${error.message}`)
  } catch (err) {
    console.error(`[refund] REFUND FAILED for request ${requestId}:`, err)
  }
}
