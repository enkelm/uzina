# Local setup

Use Bun 1.4.4 and run from the repository root, or run the built daemon from the checkout you want as its local workspace. Default local startup needs no application arguments or Factory environment configuration. It runs one Factory and its local Execution node on the same machine. It does not deploy anything or configure a transfer.

## 1. Start the Factory

Use your existing Pi sign-in, or an existing provider credential. The local runtime uses Pi's native resolver, including `~/.pi/agent/auth.json` (API keys/OAuth), `models.json` (custom providers/endpoints), and settings. There is no separate Factory model key or bootstrap secret. Startup makes no model request; subsequent model work can incur provider charges.

In terminal 1, leave this running:

```sh
bun run dev:daemon
```

The defaults are local mode, `127.0.0.1:8788`, Factory data under `~/.local/share/uzina`, and the current directory as the local workspace. Startup automatically creates and reuses:

- The Owner sign-in and a separate revocable private-assistant identity.
- A dedicated local Execution node, its private credential, and a canonical cwd-bound Workspace.
- The existing execution loop for registration, heartbeats and work requests.
- Installed Pi/Codex launch profiles and Rex discovery, with Factory worker provisioning available through the coordinator. No native worker is launched just by starting the Factory.

There is no native-worker opt-in flag, operator JSON, manual node credential to copy, or second local-node process to start. Missing native executables are diagnosed rather than weakening authorization or inventing readiness. See [native-worker defaults and recovery](native-worker-provisioning.md).

Check health in another terminal:

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/health
```

Do not delete the data directory to bypass setup or recover a token. Restart from the same checkout and origin to reconcile its native workers; another startup directory gets a separate local placement, not adoption of the previous directory's launches.

## 2. Start the web UI and sign in

In terminal 2:

```sh
bun run dev:web
```

Open the private owner link printed by the Factory for `http://127.0.0.1:5173/login` and confirm **Sign in**. There is no credential field to paste into. If Vite selected another port, change only the port in the link.

The browser gets an HttpOnly, SameSite cookie (also Secure over HTTPS). JavaScript and Web Storage do not hold the bearer. Sign out clears that cookie and the tab's private state. Links are credentials: keep the console and copied links private.

Use **Factory chat** in the header for the Owner-private coordinator: plan goals, inspect projects, provision connected workers, and review results. It is separate from Work chats and available without selecting a project. Enter sends; Shift+Enter adds a line. A reply receipt is not proof that a worker finished. The panel shows current canonical context, not a full archived transcript. Closing it does not stop admitted work. If acknowledgement is unknown, use **Reconcile Factory input** before reloading or sending again; uncertain input IDs/text are held in this tab only, not browser storage. A parked coordinator keeps saved messages readable but cannot accept input. Guests and Viewers have no access to this chat.

For a managed coding conversation, create a project and a Work item, then select the automatically available local Execution node and Workspace. A command receipt means admission, not completion. Native Pi/Codex conversations stay in Rex; they are not browser Work item chats. Ask the private Factory assistant to discover its `local` target and provision an installed native profile when you want a connected worker. Current Core project grants and Owner intent still control that launch. New connected Pi workers can then receive a typed assignment and blocking answer through the [native Pi adapter](native-pi-delivery.md), without terminal typing. `/factory pause` or Escape disarms delivery; return to the original conversation and explicitly `/factory resume` after interruption. Codex stays manual.

The Owner's **Sharing** page creates single-use invitations for a selected project or Work item, with Guest/Viewer access and a 15-minute, one-hour, one-day, or one-week expiry. It also revokes pending invitations and participant access. Guests can steer agents; Viewers can read and discuss. These are application scopes, not an OS sandbox.

## Private state and credentials

The Owner token and separate private-assistant identity are mode-0600 files beside the Factory database (`factory.sqlite.owner-token` and `factory.sqlite.assistant-identity`). SQLite stores credential hashes. A restart reuses identities, grants, projects and history. The assistant never uses the human Owner's bearer.

Local executor setup is under `factory.sqlite.local-execution/<Factory-and-cwd hash>/`, with a private immutable `identity.json`, executor SQLite and native-agent/MCP state. Generated node/worker credentials remain outside the workspace and out of prompts, launch argv and browser storage. Revocation does not grant permission to create replacement credentials on restart.

A shell-capable agent and its external Rex MCP server run with the node account's host permissions. Workspace selection, environment filtering and file modes are not OS isolation. Use a dedicated checkout without credentials. The startup workspace must not contain or overlap Factory private state; running from the entire home directory is not a safe workspace binding.

## Optional overrides

The environment examples document overrides, not startup prerequisites:

| Example                    | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `.env.example`             | Factory address/storage and model-selection overrides    |
| `apps/web/.env.example`    | Web server proxy; no secrets                             |
| `apps/daemon/.env.example` | An additional, separately provisioned connected executor |

For example, copy `.env.example` to a private file outside the workspace, restrict it with `chmod 600`, then explicitly load it:

```sh
bun --no-env-file --env-file=/absolute/private/factory.env --watch apps/daemon/src/index.ts
```

`UZINA_MODEL_PROVIDER` / `UZINA_MODEL_ID` override model selection; `PI_CODING_AGENT_DIR` selects a different Pi profile. `UZINA_FACTORY_DATABASE_PATH` and `UZINA_MANAGED_WORK_DIRECTORY` override storage. Keep storage outside the workspace and the origin stable for existing native launches. Never put credentials in `VITE_*` variables; they are exposed to browser code. An explicitly selected environment file does not remove variables already exported by your shell.

## Additional connected executors

Only additional/remote nodes need separate provisioning and a node process. The default local node above does not use this setup.

Use the existing Owner API to create a distinct node and Workspace. This local operator example reads the protected Owner token without putting it in argv or shell history:

```sh
bash <<'BASH'
set -e
IFS= read -r owner < "$HOME/.local/share/uzina/factory.sqlite.owner-token"
factory_post() {
  printf 'Authorization: Bearer %s\n' "$owner" |
    curl --fail-with-body --silent --show-error \
      --header @- --header 'Content-Type: application/json' \
      --data "$2" "http://127.0.0.1:8788$1"
  printf '\n'
}
factory_post /v1/nodes '{"nodeId":"node:extra","name":"Additional execution node"}'
factory_post /v1/workspaces '{"workspaceId":"workspace:extra","nodeId":"node:extra","name":"Additional checkout"}'
unset owner
BASH
```

These requests create resources. If they already exist, reuse their IDs and a valid node credential rather than blindly rerunning them. Store the returned **node** credential—not the Owner credential—in a private node environment file outside every workspace. Use `apps/daemon/.env.example` as a template, replacing the node/workspace IDs and absolute directory with the records you just created. Run that executor with an explicit environment file and a separate listener port:

```sh
bun --no-env-file --env-file=/absolute/private/node.env --watch apps/daemon/src/index.ts
```

The connected executor initiates authenticated registration, heartbeats and work requests to the Factory. It does not implement remote native-worker provisioning claims. These instructions cover local development, not production serving, protected remote ingress or completed managed-work transfer.
