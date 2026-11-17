# Uzina web UI

This first UI provides project and Work item creation, an explicit existing Execution node and Workspace choice, conversation text, command receipts, and history. Guest access follows the Core project grants. Viewer access is read-only. It has no transfer, ownership, activation, or terminal controls.

## Framework and UI dependencies

The app uses React 19, TanStack Start and TanStack Router on Vite. Start runs in SPA mode: only the public document shell is prerendered, and the Work route renders on the client. Factory data and cookie authentication stay behind the existing Core API, not Start loaders or server functions.

Project and Work item selection use validated `project` and `work` search parameters. Links can reopen authorized work, including an item outside the first 100 rows. Back, Forward and reload restore selection, not drafts or unresolved inputs. Router scroll restoration is disabled so it does not write navigation state to Web Storage; conversation scrolling remains local to the mounted UI. Authorization is checked again when loading a link.

`@ui-sdk/react` and `@ui-sdk/core` are pinned to `0.1.0-beta.6`. The root route imports `@ui-sdk/core/web.css` once, before the existing app styles; Tailwind is not installed. The Factory app uses ui-sdk Buttons, Fields, Inputs, Textarea, Selects, Dialogs, Collapsibles, and Avatar, styled with the existing teal palette. Controlled values use ui-sdk change callbacks so agents and keyboard/pointer users share the same behavior. Sending input requires agent confirmation. The standalone sign-in, invitation, and sharing pages remain server-rendered Core HTML; they do not depend on React or load a remote UI script. Follow the ui-sdk skill and the installed package docs before building components, as described in the root `AGENTS.md`.

Run `bun run build:web` after changing routes to regenerate `src/routeTree.gen.ts`. Start writes production assets under `dist/client` and its server entry under `dist/server`; neither is a deployment or an API gateway. A static host must serve the SPA shell for application URLs and preserve the separate Factory routes.

## Development

See [local setup](../../docs/local-setup.md) for copy/start commands, owner sign-in links, and node provisioning. This directory's `.env.example` contains only the optional web proxy address, never credentials. The real Factory environment file has a separate name and is loaded explicitly.

Run the Factory service on `127.0.0.1:8788`. See [the daemon instructions](../daemon/README.md) for native Pi credential discovery, owner links, and Execution node setup. Project creation alone does not supply an Execution node or Workspace.

From the repository root:

```sh
bun run dev:web
```

Open the private owner link printed by the local Factory and confirm **Sign in**. Other participants join through single-use invitation links. These flows adapt pi-coop's passwordless authentication/sharing to Uzina's persisted people and scopes. Sessions use HttpOnly, SameSite cookies (Secure over HTTPS); bearer values never enter React state or Web Storage. Sign out clears the cookie, forms, drafts, pending requests, receipts, and loaded private data. Treat sign-in links as credentials and keep them private.

The Owner's **Sharing** page creates expiring Guest/Viewer invitations for one project or Work item and revokes pending invitations/participant access. All authorization remains in Core, including current grants and revocation. Browser mutations reject cross-site requests. A non-secret session-ID binding rejects stale-tab mutations after a cookie account switch, and cross-tab notifications clear cached private state when another tab signs in or out.

The browser uses its own origin. Vite binds to `127.0.0.1` and proxies `/v1`, `/login`, `/join`, and `/sharing` to `http://127.0.0.1:8788`. An operator can set `UZINA_WEB_API_ORIGIN` before startup. It must be a bare origin with no path, user information, query, or fragment. HTTP is accepted only for loopback; other origins require HTTPS. Sign out before changing the configured Factory. Cookies are host-scoped: ports do not isolate them. Use a distinct browser hostname for each Controller, not just another port, and never proxy an untrusted Controller behind an already signed-in hostname. This development proxy is not production serving, private ingress, or an OS security boundary.

On a temporary connection failure, the UI hides private work, clears ordinary drafts and forms, and stops refresh requests. It retains uncertain input in memory, hidden until a retry checks current human access. Sign-out, account changes, and actual access denial clear the affected recovery state.

An uncertain input stays bound to its original Work item, request ID, and exact text. Send is disabled until recovery. Use **Reconcile request** on that Work item. A receipt proves admission, not assistant output or task completion. Drafts and uncertain inputs are memory-only: closing or reloading the tab loses that local state. Server history remains subject to current access. There is no offline queue, service worker, or PWA cache.

## Bounded navigation

The current API has no pagination for these lists. The UI requests up to 100 Work items for the selected project, oldest first, and discloses a full batch. Search covers the shown list only. Use **Open Work item by ID** for a known item outside the batch; its current authorized status supplies the thread metadata. A missing list entry does not erase an uncertain input. Projects, node/Workspace choices, and command history also have API limits of 100. History explicitly warns when newer commands may be absent; a receipt lookup can check this tab’s last accepted input separately.

A Factory can serve the catalog and command history without a managed runtime adapter. In that composition, exact-ID metadata lookup is unavailable and the UI states this limit. An already known selected Work item outside the first batch stays usable after a fresh authorized history read; its metadata is marked **last-known**, not current runtime status. A status failure alone does not disconnect the Factory or hide accessible command history.

## Checks

```sh
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
bun run --cwd apps/web test:browser
```

The browser check starts an owned disposable Factory, actual native Pi runtime, and registered Execution node. Only the external model transport is deterministic. It also checks ui-sdk agent discovery and changes, confirmation, dependent selectors, required fields, and nested mobile popups. It checks URL selection, Back/Forward, reload and out-of-batch deep links, native sign-in/sharing forms, invitation redemption, cross-tab account switching, project and Work item creation, explicit placement, human and assistant text, Guest/Viewer scope, unknown admission, lost replies after real admission, cross-Work-item recovery, exact input text, stale responses, sign-out, revocation, keyboard dialog behavior, Web Storage, mobile navigation, temporary offline recovery, and real lists/history larger than 100 records. A second owned local Factory has no runtime adapter; it verifies that status 503 does not disconnect its authorized catalog/history and that exact-ID limits are explicit.

It uses the existing local Chrome executable on macOS. Set `UZINA_WEB_BROWSER_EXECUTABLE` to use another installed Chromium executable. It does not download a browser or use a personal browser profile. Screenshots are written to `.impeccable/review/`.

This is local browser and process evidence. It is not deployment, physical-phone, two-machine, paid-provider, whole-host failure, or completed-transfer proof.
