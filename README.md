# Hyper Tic-Tac-Toe

Responsive Hyper Tic-Tac-Toe with local play, AI, LAN multiplayer, and Cloudflare-hosted internet multiplayer.

## Deploy to Cloudflare from GitHub

1. Push this entire folder to your GitHub repository. Keep `wrangler.jsonc`, `package.json`, `src/`, and `public/` at the repository root.
2. In Cloudflare Workers & Pages, import the GitHub repository as a Worker project.
3. Use `npm run deploy` as the deploy command if Cloudflare asks for one. (`npx wrangler deploy` also works.)
4. No build command or output directory is needed: Wrangler uploads `./public` because it is declared in `wrangler.jsonc`.
5. Deploy. Static requests are served from `public/`; `/ws` is handled by the Worker and the `GameLobby` Durable Object.

You can also deploy from a terminal:

    npm install
    npx wrangler login
    npm run deploy

## Run on a LAN instead

Requires Node.js 16+.

    node hyper-server.js

Open the printed `http://192.168...:3000` address on devices connected to the same Wi-Fi/LAN. The same browser client automatically uses the local WebSocket relay at `/ws`.

## Multiplayer modes

- Classic: all marks are visible.
- Memory: only the playable board is visible; players have limited peeks.
- Blindfold: multiplayer only. Occupied positions appear empty; only the previous move is shown/highlighted.

The host chooses the mode and win condition, then starts the game. Moves and restarts are relayed to the other browser.
