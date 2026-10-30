import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

import { certDir } from './server/project-path.mjs'


// The dev server serves over the same certificate as production, so the dev and
// production origins behave identically (secure context, wss:// sockets).
const CERT_DIR = certDir()
const TLS_CERT = process.env.DEVPANEL_TLS_CERT ?? path.join(CERT_DIR, 'localhost.crt')
const TLS_KEY = process.env.DEVPANEL_TLS_KEY ?? path.join(CERT_DIR, 'localhost.key')
const TLS_ON = process.env.DEVPANEL_TLS !== '0' && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)
const devHttps = TLS_ON ? { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) } : undefined

// Where `npm run dev:client` proxies API and websocket traffic. This follows the
// same PORT/HOST that start.sh gives the API process, so changing the API port
// does not silently break the dev proxy.
const API_PORT = process.env.PORT ?? '443'
// A server bound to 0.0.0.0 is still reached over loopback from here.
const API_HOST = (process.env.HOST ?? '127.0.0.1').split(',')[0].trim().replace(/^(0\.0\.0\.0|::)$/, '127.0.0.1')
const API_TARGET = process.env.DEVPANEL_API ?? `${TLS_ON ? 'https' : 'http'}://${API_HOST}:${API_PORT}`

export default defineConfig({
  plugins: [
    vue(),
    // Tree-shakes Vuetify: only the components actually used end up in the bundle.
    vuetify({ autoImport: true })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: process.env.DEVPANEL_DEV_HOST ?? '0.0.0.0',
    port: Number(process.env.DEVPANEL_DEV_PORT ?? 5173),
    strictPort: true,
    https: devHttps,
    proxy: {
      // secure:false — the backend presents the same self-signed certificate,
      // which no trust store vouches for.
      '/api': { target: API_TARGET, changeOrigin: true, secure: false },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true, secure: false }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900
  }
})
