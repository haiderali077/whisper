# Whisper frontend

React/Vite client for Whisper, with Zustand state, Socket.IO subscriptions, message retry states and an IndexedDB offline outbox.

See the [project README](../README.md) for architecture, Docker setup, tests and current limitations.

## Development

With the distributed backend running, execute from the repository root:

```sh
npm ci --prefix frontend
VITE_BACKEND_URL=http://localhost:8080 npm run dev --prefix frontend
```

`VITE_BACKEND_URL` selects the API and socket origin. Without an override, Vite development uses `http://localhost:5001`; production builds use same-origin requests.

## Checks

```sh
npm run lint --prefix frontend
npm run build --prefix frontend
```

Lint and build checks do not replace browser interaction tests; automated UI tests are not currently implemented.
