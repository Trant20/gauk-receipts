import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createClient } from '@supabase/supabase-js';
import type { CloudflareEnv } from '../../../lib/constants';

const VALID_COUNTRIES = new Set([
  'NZ', 'AU', 'GB', 'US', 'CA', 'IE', 'ZA', 'SG', 'EU'
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { country } = await request.json();

    if (!country || !VALID_COUNTRIES.has(country.toUpperCase())) {
      return json({ error: 'Invalid country code.' }, 400);
    }

    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized.' }, 401);
    }

    const token = auth.slice(7);
    const cfEnv = env as unknown as CloudflareEnv;
    const supabase = createClient(
      cfEnv.PUBLIC_SUPABASE_URL,
      cfEnv.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: 'Invalid token.' }, 401);

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        country: country.toUpperCase()
      }
    });

    if (error) {
      console.error('location update error:', error.message);
      return json({ error: error.message }, 500);
    }

    return json({ ok: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error.';
    console.error('api/user/location error:', message);
    return json({ error: 'Server error.' }, 500);
  }
};
