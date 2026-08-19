export const SITE_ID = import.meta.env.SITE_ID as string;
export const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string;
export const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;
export const SITE_NAME = 'GAUK Receipts';
export const SITE_URL = 'https://gaukreceipts.com';

/** Cloudflare Workers environment bindings */
export type CloudflareEnv = {
  PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  SITE_ID: string;
  SESSION: KVNamespace;
  gauk_insurance_images: R2Bucket;
};
