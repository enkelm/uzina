# Working in Uzina

- Use Bun 1.4.4 and the workspace lockfile. Do not bypass a dependency release-age policy; ask the user if it blocks an install.
- Run `bun run check`, `bun run typecheck`, `bun run test`, and `bun run build` after dependency or runtime changes. Use `bun run format` for Oxfmt and `bun run lint` for Oxlint.
- The web app uses React 19 and TanStack Start in SPA mode. Keep Factory authentication and authorization in the existing Core API; do not serialize private Factory data into the app shell.
- Before using ui-sdk, follow `.agents/skills/ui-sdk/SKILL.md` if installed, and read `node_modules/@ui-sdk/react/docs/llms.txt` from `apps/web`. To build a new component, also search `node_modules/@ui-sdk/react/docs/core.md` by heading and read `rendering.md` next to it.
- TanStack generates `apps/web/src/routeTree.gen.ts`. Do not edit it manually; run `bun run build:web` after changing routes.
