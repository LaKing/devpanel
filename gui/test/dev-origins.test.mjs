import { devOrigins } from '../server/dev-origins.mjs'

export const name = 'the origins socket.io accepts: the Vite ones in dev, none in production'

export default async function (t) {
  const vite = ['https://localhost:5173', 'https://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5173']
  t.eq('production accepts no dev origin', devOrigins({ NODE_ENV: 'production' }), [])
  t.eq('production ignores DEVPANEL_DEV_ORIGINS left over from a dev shell', devOrigins({ NODE_ENV: 'production', DEVPANEL_DEV_ORIGINS: 'https://localhost:5173' }), [])
  t.eq('dev accepts the Vite origins', devOrigins({}), vite)
  t.eq('dev takes DEVPANEL_DEV_ORIGINS when it is set', devOrigins({ NODE_ENV: 'development', DEVPANEL_DEV_ORIGINS: 'https://a.example, https://b.example ,' }), ['https://a.example', 'https://b.example'])
}
