# Local setup

Use Bun 1.4.4. Run the commands below from the repository root. This setup runs one Factory, its web UI, and one Execution node on the same machine. It does not deploy anything or configure a transfer.

## 1. Copy the environment examples

```sh
cp -n .env.example .env.factory.local
cp -n apps/web/.env.example apps/web/.env.local
cp -n apps/daemon/.env.example apps/daemon/.env.node.local
chmod 600 .env.factory.local apps/web/.env.local apps/daemon/.env.node.local
```

`cp -n` preserves existing files. The real files are Git-ignored; the examples contain no credentials.

| Example                    | Local file                    | Used by                      |
| -------------------------- | ----------------------------- | ---------------------------- |
| `.env.example`             | `.env.factory.local`          | Optional Factory settings    |
| `apps/web/.env.example`    | `apps/web/.env.local`         | Web server proxy, no secrets |
| `apps/daemon/.env.example` | `apps/daemon/.env.node.local` | Execution node and Workspace |

The web file is optional at the default Factory address, but the explicit commands below use it. The node file is needed to supply an execution target for Work items, not just to open the UI. Private assistant, import, and Cloudflare environment files are not needed for this local setup.

## 2. Configure and start the Factory

No Factory bootstrap secret or separate model API key is required. Sign in with Pi as usual, or use an existing provider environment variable such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The local runtime uses Pi's native resolver, including `~/.pi/agent/auth.json` (API keys/OAuth), `models.json` (custom providers/endpoints), and settings. `PI_CODING_AGENT_DIR` selects another Pi profile.

Keep `UZINA_MODE=local`, `HOST=127.0.0.1`, and `PORT=8788`. `UZINA_MODEL_PROVIDER` and `UZINA_MODEL_ID` are optional selection overrides, not credential setup. Without overrides, the host prefers Pi's available default and otherwise selects an available authenticated model. No dummy fallback is installed. Model work can incur charges at your provider's rates; startup makes no model request.

In terminal 1, leave this running:

```sh
bun --no-env-file --env-file=.env.factory.local --watch apps/daemon/src/index.ts
```

Check the public health endpoint in another terminal:

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/health
```

The Factory stores data under `~/.local/share/uzina` by default. Do not delete that directory to bypass setup or recover a token.

## 3. Open your owner sign-in link

The Factory prints a private owner link for `http://127.0.0.1:5173/login`. Start the web UI in step 5, open that link, and confirm **Sign in**. There is no credential field to paste into. If Vite selected another port, change only the port in the link.

The browser gets an HttpOnly, SameSite cookie (also Secure over HTTPS). JavaScript and Web Storage do not hold the bearer. Sign out clears that cookie and the tab's private state. Links are credentials: keep the console and copied links private.

Local startup provisions the owner automatically. The owner token and a separate named private-assistant identity are stored in mode-0600 files beside the Factory database (`factory.sqlite.owner-token` and `factory.sqlite.assistant-identity`). SQLite stores credential hashes. A restart reuses these identities; it does not reset people, grants, projects, or history. The assistant still uses its own revocable grants, never the human owner's bearer.

The Owner's **Sharing** page creates single-use invitations for a selected project or Work item, with Guest/Viewer access and a 15-minute, one-hour, one-day, or one-week expiry. It also revokes pending invitations and participant access. Guests can steer agents; Viewers can read and discuss. These are application scopes, not an OS sandbox.

## 4. Provision the Execution node and Workspace

The UI selects existing resources; it does not provision machines. For first setup, the following local operator command reads the protected owner token file to create `node:local` and `workspace:repo`. Adjust the file path if you changed the database path:

```sh
bash <<'BASH'
set -e
IFS= read -r owner < "$HOME/.local/share/uzina/factory.sqlite.owner-token"
factory_post() {
  printf 'Authorization: Bearer %s\n' "$owner" |
    curl --fail-with-body --silent --show-error \
      --header @- \
      --header 'Content-Type: application/json' \
      --data "$2" \
      "http://127.0.0.1:8788$1"
  printf '\n'
}
factory_post /v1/nodes '{"nodeId":"node:local","name":"Local execution node"}'
factory_post /v1/workspaces '{"workspaceId":"workspace:repo","nodeId":"node:local","name":"Repository"}'
unset owner
BASH
```

Save the first response's `credential`: this one is the **node credential**, not a UI credential. Put it in `UZINA_NODE_CREDENTIAL` in `apps/daemon/.env.node.local`. The second response describes the Workspace and does not issue another token. These requests create resources; if they already exist, reuse their IDs and a valid node credential rather than blindly rerunning provisioning.

In that same node file, replace `/absolute/path/to/your/checkout` with the existing absolute path of the project you want the node to work on. Keep the JSON array on one line. The IDs must match the provisioned records.

In terminal 2, leave this running:

```sh
bun --no-env-file --env-file=apps/daemon/.env.node.local --watch apps/daemon/src/index.ts
```

The node uses port `8789`, so it does not conflict with the Factory's `8788`. It initiates authenticated registration, heartbeat, and work requests to the Factory.

## 5. Start the web UI

The example web file points to `http://127.0.0.1:8788`. It contains no token or model key.

In terminal 3, leave this running:

```sh
bun --no-env-file --env-file=apps/web/.env.local run dev:web
```

Open the private owner link from step 3 and confirm sign-in. Create a project and a Work item, then explicitly select the provisioned Execution node and Workspace. A configured model request can incur provider charges; a received command receipt means admission, not completion.

## Keep the credentials separate

- **Model credentials:** Pi's native profile and provider environment; no duplicate Factory model key.
- **Owner sign-in:** protected local file and private link; HttpOnly browser cookie.
- **Private assistant:** separate protected local identity file; current Core grants/revocation still apply.
- **Node credential:** node file only.
- **Web file:** proxy address only. Never put secrets in `VITE_*` variables; those are exposed to browser code.

The commands explicitly select an environment file and disable automatic `.env` loading. This avoids loading the Factory file into the node or web process; it does not remove variables you already exported in the shell. Restart the relevant process after changing its configuration.

Use a dedicated checkout without credentials as the Workspace. Git-ignore rules and managed path/admission checks are not an OS sandbox: a shell-capable agent runs with the node account's host permissions. If the Workspace is Uzina itself, keep the real environment files outside that checkout and pass their absolute paths with `--env-file` to reduce accidental exposure. That does not restrict host permissions.

These examples cover local development, not production serving, protected remote ingress, or completed managed-work transfer.
