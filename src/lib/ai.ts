import type { SupabaseClient } from '@supabase/supabase-js'

/** Fetch prompt config from ai_prompts for the given context, fallback to general.
 *  Pass the select string appropriate for the calling route. */
export async function getPromptConfig(
  supabase: SupabaseClient,
  site_id: string,
  context: string,
  select: string
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('ai_prompts')
    .select(select)
    .eq('site_id', site_id)
    .eq('context', context)
    .single()

  if (data) return data as Record<string, unknown>

  const { data: fallback } = await supabase
    .from('ai_prompts')
    .select(select)
    .eq('site_id', site_id)
    .eq('context', 'general')
    .single()

  return fallback as Record<string, unknown> | null
}

// NOTE: This file is a temporary duplicate of gauk-antiques/src/lib/ai.ts
// Pending MC decision on @gauk-network/core shared package.
