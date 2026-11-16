# Running the assistant on a separate computer

The **worker** is the program that asks the dashboard server for new requests and uses Claude to do the work. It must run somewhere even if you host the dashboard on Railway.

## Any computer you keep running

1. Install Git, Node.js 24, and pnpm 9.15.0 on that computer.
2. Clone your own repository and enter its folder, as in the README.
3. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @ea/agent build
   cp apps/agent/.env.example apps/agent/.env
   ```

4. Edit `apps/agent/.env`. Set `SWITCHBOARD_URL` to your hosted dashboard's HTTPS address, `AGENT_TOKEN` to the exact token on its server, and `ANTHROPIC_API_KEY` to your own key. Select an `AGENT_MODEL` your account supports. Leave `AGENT_MACHINE_ID` blank unless you configured InstaBox.
5. Run:

   ```sh
   pnpm --filter @ea/agent start
   ```

6. Look for `Connected. Waiting for work.` Send a message from the dashboard and confirm a reply.

This computer does not need Postgres, Python, uv, Zoho credentials, or the dashboard password. Those live on the server. Its `apps/agent/.env` takes precedence over a repository-root `.env`; keep the values consistent. The process needs an internet connection and must stay running. For unattended operation, use your machine's process supervisor to restart it after reboots or failures. Keep the `AGENT_WORKDIR` folder persistent so Claude sessions can be resumed.

Use one worker per installation. Stop the old worker when moving to a new machine. A local worker can process requests without InstaBox; the remote desktop and power controls require InstaBox.

## InstaBox computer and dashboard power controls

This matches the original application's hosting arrangement: Railway hosts the website and database; your own InstaBox machine runs the worker. The dashboard can wake, pause, or show the desktop of that selected machine. Creating the machine alone does not install the worker.

1. Create a Linux machine in your own InstaBox account. Record its machine ID and your InstaBox API key.
2. On the **dashboard server**, set `INSTABOX_API_KEY` and `INSTABOX_BOX_ID`. Restart or redeploy the server.
3. Open the new machine's terminal using InstaBox. Install Git, Node.js 24, and pnpm 9.15.0 if missing.
4. Clone your own repository to `/data/home/email-campaign-agent` (replace the GitHub URL below with yours):

   ```sh
   git clone https://github.com/YOUR-USERNAME/my-email-agent.git /data/home/email-campaign-agent
   cd /data/home/email-campaign-agent
   pnpm install --frozen-lockfile
   pnpm --filter @ea/agent build
   cp apps/agent/.env.example apps/agent/.env
   ```

5. Edit `/data/home/email-campaign-agent/apps/agent/.env` with the hosted `SWITCHBOARD_URL`, matching `AGENT_TOKEN`, your Claude key, and your model. Set **`AGENT_MACHINE_ID` to exactly the server's `INSTABOX_BOX_ID`**. The server rejects other machines when an InstaBox ID is selected.
6. The dashboard's startup command expects `/data/home/ea-agent/run.sh` and `/data/home/ea-agent/dist/index.js`. On a fresh machine, create the expected link and launcher:

   ```sh
   ln -s /data/home/email-campaign-agent/apps/agent /data/home/ea-agent
   cat > /data/home/ea-agent/run.sh <<'SCRIPT'
   #!/bin/sh
   set -eu
   cd /data/home/ea-agent
   exec node /data/home/ea-agent/dist/index.js
   SCRIPT
   chmod +x /data/home/ea-agent/run.sh
   chmod 600 /data/home/ea-agent/.env
   ```

   If `/data/home/ea-agent` already exists, inspect it first; do not overwrite another installation. The launcher needs `node` available on the non-interactive shell's PATH. If your Node installer only exposes it in an interactive terminal, replace `node` in the launcher with the absolute path printed by `command -v node` on that machine.
7. Run `/data/home/ea-agent/run.sh` once in the terminal and verify a dashboard conversation. Stop it with Ctrl+C, then use the dashboard's computer power control to start it in the background. Confirm it responds again. Background logs go to `/data/home/ea-agent/agent.log`.

Keep your worker credentials on that computer and out of GitHub. Do not copy someone else's Claude login, worker history, or app credentials. InstaBox availability and runtime limits are controlled by your own account.

## Updating the worker

Stop the worker using your process supervisor (or pause it during maintenance), pull changes in your repository folder, then rerun:

```sh
pnpm install --frozen-lockfile
pnpm --filter @ea/agent build
```

Restart it and verify a new dashboard conversation. Do not run an old and new worker at the same time against the same server.
