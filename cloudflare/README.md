# MinecraftZ Worlds Worker

This directory contains the Cloudflare Worker API and Wrangler configuration for persistent MinecraftZ worlds.

Cloudflare Worker settings:
- Production branch: `main`
- Root directory: `/cloudflare`
- Build command: none
- Deploy command: `npx wrangler deploy`
- Preview builds: disabled

The Worker uses the `WORLDS` Durable Object binding and the SQLite-backed `World` class declared in `wrangler.toml`.
