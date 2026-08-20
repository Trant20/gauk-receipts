import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import type { CloudflareEnv } from '../../../lib/constants';
import { getPromptConfig } from '../../../lib/ai';

const GUEST_SCAN_LIMIT = 1;
const GUEST_SCAN_TTL   = 60 * 60 * 24; // 24 hours

const CURRENCY_MAP: Record<string, { code: string; symbol: string; name: string }> = {
  NZ: { code: 'NZD', symbol: 'NZ$', name: 'New Zealand' },
  AU: { code: 'AUD', symbol: 'AU$', name: 'Australia' },
  GB: { code: 'GBP', symbol: '£',   name: 'the United Kingdom' },
  US: { code: 'USD', symbol: '$',   name: 'the United States' },
  CA: { code: 'CAD', symbol: 'CA$', name: 'Canada' },
  EU: { code: 'EUR', symbol: '€',   name: 'Europe' },
};

function getCurrency(countryCode: string) {
  return CURRENCY_MAP[countryCode] || { code: 'USD', symbol: '$', name: 'your region' };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCodePoint(...chunk);
  }
  return btoa(binary);
}

function getSupabase() {
  return createClient(
    (env as unknown as CloudflareEnv).PUBLIC_SUPABASE_URL,
    (env as unknown as CloudflareEnv).SUPABASE_SERVICE_ROLE_KEY
  );
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}



async function getAntiqueCategories(supabase: any): Promise<string> {
  // Intentional cross-property query — antique categories are defined in GA site_settings
  const GA_SITE_ID = 'add6d12c-ecd8-4517-b2e5-0f4977603744'
  const { data } = await supabase
    .from('site_settings')
    .select('key')
    .eq('site_id', GA_SITE_ID)
    .like('key', 'category_title_%')

  if (!data || !data.length) {
    return 'Ceramics | Glass | Jewellery | Silver | Furniture | Art | Metalware | Militaria | Toys | Textiles | Clocks and Watches | Books and Literature | Stamps and Coins | Music | Memorabilia | Pottery | Collectibles and Decorative Arts | Film and Media | Antiquities'
  }

  return data
    .map((row: any) => row.key.replace('category_title_', '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))
    .filter((cat: string) => !cat.includes('Test') && !cat.includes('Rrr') && cat.length < 50)
    .join(' | ')
}


export const POST: APIRoute = async ({ request }) => {
  try {
    const { key, mode = 'guest' } = await request.json();
    if (!key) return json({ error: 'No image key provided.' }, 400);

    const countryCode = (request as any).cf?.country || 'US';
    const currency = getCurrency(countryCode);

    const supabase = getSupabase();
    const cfEnv = env as unknown as CloudflareEnv;
    const siteId = cfEnv.SITE_ID;

    const auth = request.headers.get('Authorization');
    let userId: string | null = null;

    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return json({ error: 'Invalid token.' }, 401);
      userId = user.id;

      // Check credit balance before AI call — deduct after DB insert with real ID
      const { data: creditRow } = await supabase
        .from('credits')
        .select('balance')
        .eq('user_id', userId)
        .single();

      if (!creditRow || creditRow.balance < 1) {
        return json({ error: 'Insufficient credits.', credits_exhausted: true }, 402);
      }

    } else {
      // Guest — enforce limit via KV
      const kv = cfEnv.SESSION;
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const kvKey = `gi_guest_scan:${ip}`;

      if (kv) {
        const existing = await kv.get(kvKey);
        const count = existing ? parseInt(existing, 10) : 0;
        if (count >= GUEST_SCAN_LIMIT) {
          return json({ error: 'Create a free account to continue scanning.', guest_limit: true }, 429);
        }
      }
    }

    // Fetch image from R2
    const bucket = cfEnv.gauk_insurance_images;
    const object = await bucket.get(key);
    if (!object) return json({ error: 'Image not found.' }, 404);

    const arrayBuffer = await object.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const rawType = object.httpMetadata?.contentType || 'image/jpeg';
    const allowed = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    const contentType = allowed.has(rawType) ? rawType : 'image/jpeg';

    // Fetch prompt config from ai_prompts
    console.log("SITE_ID:", siteId);
    const promptConfig = await getPromptConfig(supabase, siteId, 'general', 'system_prompt, model, max_tokens');
    if (!promptConfig) return json({ error: 'Prompt configuration not found.' }, 500);

    // Build mode-specific prompt — apply runtime substitutions to stored template
    const modeInstruction = mode === 'guest'
      ? 'End with a natural suggestion to save this item to a home inventory before they forget the details.'
      : 'End with a specific question about what else in this room or category they should catalogue next.';

    const antiqueCategories = await getAntiqueCategories(supabase);

    const systemPrompt = (promptConfig.system_prompt as string)
      .replaceAll('MODE_INSTRUCTION', modeInstruction)
      .replaceAll('CURRENCY', currency.code)
      .replaceAll('ANTIQUE_CATEGORIES', antiqueCategories);

    // Call Claude
    console.log("API KEY PREFIX:", cfEnv.ANTHROPIC_API_KEY?.slice(0, 8));
    const client = new Anthropic({ apiKey: cfEnv.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: promptConfig.model as string,
      max_tokens: promptConfig.max_tokens as number,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: contentType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: base64
            }
          },
          {
            type: 'text',
            text: `Identify this item and return the JSON. Currency: ${currency.code}. Return only the JSON object.`
          }
        ]
      }]
    });

    if (!response.content[0] || response.content[0].type !== 'text') {
      return json({ error: 'No response from AI.' }, 500);
    }

    let result: Record<string, unknown>;
    try {
      const raw = response.content[0].text;
      const clean = raw.replaceAll('```json', '').replaceAll('```', '').trim();
      result = JSON.parse(clean);
    } catch {
      return json({ error: 'AI returned malformed response.' }, 500);
    }

    // Detect receipts vs identifications
    const isReceipts = siteId === '30f3c0d1-2694-4db5-82e9-b3805a903643'
    const r = result as any

    let record: { id: string } | null = null

    if (isReceipts) {
      // Write to receipts table
      const { data: receiptRecord, error: receiptError } = await supabase
        .from('receipts')
        .insert({
          site_id: siteId,
          user_id: userId,
          image_key: key,
          merchant:        r.merchant        || null,
          date:            r.date            || null,
          total:           r.total           ?? null,
          currency:        r.currency        || null,
          category:        r.category        || null,
          receipt_number:  r.receipt_number  || null,
          warranty_years:  r.warranty_years  ?? null,
          warranty_expiry: r.warranty_expiry || null,
          confidence:      r.confidence      || null,
          notes:           r.notes           || null,
          result_json:     result,
          credits_used:    1
        })
        .select()
        .single()

      if (receiptError) {
        console.error('Receipt DB write error:', receiptError.message)
      } else if (receiptRecord && r.items?.length) {
        const lineItems = r.items.map((item: any) => ({
          receipt_id:  receiptRecord.id,
          description: item.description,
          amount:      item.amount ?? item.line_total ?? null
        }))
        await supabase.from('receipt_line_items').insert(lineItems)
      }
      record = receiptRecord
    } else {
      // Write to identifications table
      const { data: idRecord, error: dbError } = await supabase
        .from('identifications')
        .insert({
          site_id: siteId,
          user_id: userId,
          image_key: key,
          result_json: result,
          category: r.category,
          value_range_low: r.value_range_low,
          value_range_high: r.value_range_high,
          confidence: r.confidence,
          credits_used: 1
        })
        .select()
        .single()
      if (dbError) console.error('DB write error:', dbError.message)
      record = idRecord
    }

    // Deduct credit after DB insert with real ID
    if (userId && record?.id) {
      const { data: deducted } = await supabase.rpc('deduct_identification_credit', {
        p_user_id: userId,
        p_site_id: siteId,
        p_identification_id: record.id
      })
      if (!deducted) console.error('Credit deduction failed:', record.id)
    }

    // Increment guest counter
    if (!userId) {
      const kv = cfEnv.SESSION
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      const kvKey = `gi_guest_scan:${ip}`
      if (kv) {
        const existing = await kv.get(kvKey)
        const count = existing ? parseInt(existing, 10) : 0
        await kv.put(kvKey, String(count + 1), { expirationTtl: GUEST_SCAN_TTL })
      }
    }

    if (isReceipts) {
      // Return receipt-shaped response
      const sym: Record<string,string> = { NZD: 'NZ$', AUD: 'A$', GBP: '£', USD: '$', EUR: '€' }
      const currency_code = r.currency || 'NZD'
      const symbol = sym[currency_code] || currency_code + ' '
      const totalDisplay = r.total ? symbol + Number(r.total).toFixed(2) : ''
      const savingsTotal = r.savings_total
        ? r.items?.reduce((acc: number, i: any) => acc + (i.original_price && i.is_on_sale ? (i.original_price - i.unit_price) * (i.quantity || 1) : 0), 0)
        : null

      return json({
        id:             record?.id || null,
        merchant:       r.merchant || null,
        merchant_branch: r.merchant_branch || null,
        merchant_gst:   r.merchant_gst_no || null,
        date:           r.date || null,
        time:           r.time || null,
        total:          r.total || null,
        total_display:  totalDisplay,
        currency:       currency_code,
        category:       r.category || null,
        confidence:     r.confidence || null,
        confidence_note: r.confidence_note || null,
        items:          r.items || [],
        tax_amount:     r.tax_amount || null,
        tax_label:      r.tax_label || null,
        savings_total:  r.savings_total || null,
        payment_method: r.payment_method || null,
        receipt_number: r.receipt_number || null,
        warranty_years: r.warranty_years || null,
        warranty_expiry: r.warranty_expiry || null,
        notes:          r.notes || null,
      })
    }

    // GI/GA response
    const low  = r.value_range_low  as number
    const high = r.value_range_high as number
    const valueDisplay = low && high
      ? `${currency.symbol}${low.toLocaleString()} – ${currency.symbol}${high.toLocaleString()}`
      : 'Value unknown'

    return json({
      id: record?.id || null,
      category:       r.category,
      title:          r.title,
      description:    r.description,
      value_display:  valueDisplay,
      value_range_low:  low,
      value_range_high: high,
      confidence:     r.confidence,
      is_antique:     r.is_antique,
      antique_category: r.antique_category || null,
      maker:          r.maker || null,
      period:         r.period || null,
      style:          r.style || null,
      condition:      r.condition || null,
      commentary:     r.commentary,
      commentary_hook: r.commentary_hook,
      country:        countryCode,
      country_name:   currency.name,
      currency:       currency.code,
    })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('scan/identify error:', message);
    return json({ error: message }, 500);
  }
};
