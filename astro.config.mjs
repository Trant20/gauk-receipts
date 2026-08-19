// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const adapter = process.env.CF_PAGES
  ? cloudflare({ platformProxy: { enabled: false } })
  : node({ mode: 'standalone' });

export default defineConfig({
  output: 'server',
  adapter,
  site: 'https://gaukinsurance.com',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        external: ['cloudflare:workers', '@anthropic-ai/sdk'],
      },
    },
  },
});
