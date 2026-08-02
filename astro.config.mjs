// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://www.dlartcompany.com',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
