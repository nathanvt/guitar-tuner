import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Phone testing goes through a Cloudflare quick tunnel (https://*.trycloudflare.com),
// so both servers have to accept that host.
const tunnelHosts = ['.trycloudflare.com'];

export default defineConfig({
  server: { allowedHosts: tunnelHosts },
  preview: { allowedHosts: tunnelHosts },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Guitar Tuner',
        short_name: 'Tuner',
        description: 'A chromatic guitar tuner that listens through the microphone.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0e0f11',
        theme_color: '#0e0f11',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
      },
    }),
  ],
});
