# Deploying NoteHelper (free)

**Architecture:** static frontend on **Vercel**, Flask backend on **Fly.io** (with a
persistent volume so ChromaDB survives restarts).

## 1. Backend → Fly.io

Install the CLI and sign in:

```bash
brew install flyctl
fly auth signup   # or: fly auth login
```

From the repo root:

```bash
# Claim an app name (skip the deploy + any generated config; we already have fly.toml).
# If "notehelper-api" is taken, edit `app = ...` in fly.toml to your chosen name.
fly launch --no-deploy --copy-config --name notehelper-api --region iad

# Persistent volume for ChromaDB (must match [mounts].source + region in fly.toml).
fly volumes create notehelper_data --size 1 --region iad

# Secrets (NOT baked into the image). Use your real Gemini key.
fly secrets set GEMINI_API_KEY=your_key_here

# Deploy.
fly deploy
```

Your backend is now at `https://notehelper-api.fly.dev` (swap in your app name).
Test it: `curl https://notehelper-api.fly.dev/documents` should return JSON.

## 2. Frontend → Vercel

1. Edit `frontend/config.js` and set your backend URL:
   ```js
   window.API_BASE = 'https://notehelper-api.fly.dev';
   ```
2. Push to GitHub, then on vercel.com: **New Project → import this repo**.
   `vercel.json` already points the output at `frontend/`, so no build step is needed.
   (Alternatively set the project's **Root Directory** to `frontend` in the dashboard.)
3. Deploy. You'll get a URL like `https://notehelper.vercel.app`.

## 3. Connect the two (CORS)

Tell the backend to accept requests from your Vercel domain:

```bash
fly secrets set FRONTEND_ORIGINS=https://notehelper.vercel.app
```

(Comma-separate multiple origins, e.g. add your `*.vercel.app` preview URL.)

Done. Re-running `fly deploy` or `vercel --prod` redeploys either side.

## Notes
- `min_machines_running = 0` scales the backend to zero when idle to stay within Fly's
  free allowance; the first request after idle has a few-seconds cold start.
- The 1 GB VM is needed because `chromadb`/`onnxruntime` OOMs on smaller sizes.
- Keep `--workers 1` (in the Dockerfile) so only one process writes to ChromaDB.
