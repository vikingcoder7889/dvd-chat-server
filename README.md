# DVD Chat WebSocket Server

A tiny Node.js WebSocket server for your site's Community Chat.

## Local run

```bash
npm install
npm start
```

It listens on `http://localhost:8787` and WebSocket path `/chat`.

## Deploy (quick options)

- **Render.com** (free tier): create a _Web Service_, select this repo/zip, set `Start Command` to `npm start`.
- **Railway.app**: New Project → Deploy from repo/zip, set `Start Command` to `npm start`.
- **Glitch.com**: New Project → Import from GitHub (or upload files) → add a `.glitch-assets` if needed (not required here). The app will run automatically.

After deployment, your WebSocket URL will look like:
`wss://YOUR-APP.onrender.com/chat`  (or the domain Railway/Glitch gives you).

Update your website's `WS_URLS` array to include that URL as the first entry.
