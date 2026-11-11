import type { SupabaseClient } from '@supabase/supabase-js'

// What a scan costs, in credits, is the price set on the product in GMC. It is saved as a setting for this site
// (site_settings), and this reads it. The default is the only fallback: it applies when the site has no setting yet or
// the setting is not a whole number of zero or more. Do not write a price into a screen or a route; read it here.

export const CREDIT_COST_DEFAULTS = {
  credit_cost_identify: 1,
} as const

export type CreditCostKey = keyof typeof CREDIT_COST_DEFAULTS

export function parseCreditCost(raw: unknown, key: CreditCostKey): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(n) && n >= 0 ? n : CREDIT_COST_DEFAULTS[key]
}

export async function getCreditCost(supabase: SupabaseClient, siteId: string, key: CreditCostKey): Promise<number> {
  const { data } = await supabase.from('site_settings').select('value').eq('site_id', siteId).eq('key', key).maybeSingle()
  return parseCreditCost(data?.value, key)
}
