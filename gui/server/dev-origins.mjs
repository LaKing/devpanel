/*
 * The origins socket.io accepts besides the panel's own. In development the Vue
 * app is served by Vite on its own origin, so its address must be accepted; in
 * production the app is served from this origin and needs nothing. Production
 * wins over DEVPANEL_DEV_ORIGINS: a shell still configured for development must
 * not carry its origins into a production panel.
 */
const VITE_ORIGINS = 'https://localhost:5173,https://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5173'

export function devOrigins (env = process.env) {
  if (env.NODE_ENV === 'production') return []
  return (env.DEVPANEL_DEV_ORIGINS ?? VITE_ORIGINS).split(',').map((origin) => origin.trim()).filter(Boolean)
}
