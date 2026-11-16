# Email Campaign Agent

A self-hosted email campaign agent with a dashboard, approvals, drafts, and step-by-step setup. It helps a rental business plan, write, and improve its marketing emails. You talk to it in the dashboard, review its work, and decide how much control to keep over campaign actions.

This template comes from a working application. It includes the real dashboard, Claude worker, database, integrations, and approval system. Your copy starts empty: you bring your own accounts, listings, mailing lists, and campaign history.

**This is software you install and run yourself.** Copying the repository gives you the code; it does not create accounts, pay for services, or start the assistant automatically. The instructions below use a terminal (an app where you paste commands). A technical friend or coding assistant can help with the initial setup.

## What it does

- **Plans campaigns:** uses current rental listings and past campaign results to propose emails.
- **Writes drafts:** assembles subject lines, copy, listing photos, prices, and links into an email preview.
- **Keeps you in control:** asks for approval according to your settings before actions such as sending a test, uploading a draft, or removing bounced contacts.
- **Shows results:** imports Zoho campaign history and compares opens, clicks, and other results.
- **Remembers preferences:** saves approved lessons for future conversations.
- **Works on a schedule:** can refresh data, plan emails, review results, and check bounced addresses.
- **Connects to other apps:** optional Gmail and other connections through Composio; optional email, iMessage, and image tools.

**It does not send or schedule a live marketing campaign.** It uploads a draft to Zoho Campaigns. You review and send it there. A test email goes to the owner, through AgentMail, not to the mailing list.

The included listing importer and writing instructions are designed for **residential rentals using AppFolio and Zoho Campaigns**. Other businesses can reuse the application, but replacing the listing source or campaign provider requires code changes. Connecting Gmail does not replace the Zoho campaign integration.

## How the pieces fit together

| Piece | Plain-language explanation | Where it runs |
| --- | --- | --- |
| Dashboard and server | The website you use, plus the coordinator that stores conversations and approvals | Your computer initially; Railway for an always-available website |
| PostgreSQL database | Stores your settings, drafts, history, and connected-account credentials | Local PostgreSQL initially; a separate Railway database when hosted |
| Claude worker | The process that picks up your requests and does the thinking and tool use | A terminal on your computer, or a separate always-on computer such as InstaBox |
| Data importer | Copies your public listings and Zoho results into the dashboard | Started by the server; uses Python and uv |

The website can load while the worker is stopped, but requests will wait until the worker is running. Hosting the website alone does **not** start the worker.

## What you need

For the initial local setup:

- [Git](https://git-scm.com/downloads), to download the code.
- [Node.js 24](https://nodejs.org/en/download), to run the application.
- pnpm 9.15.0, installed in the steps below.
- [PostgreSQL](https://www.postgresql.org/download/), installed and running locally, with its command-line tools available.
- [uv](https://docs.astral.sh/uv/getting-started/installation/), which installs the Python packages. This project needs Python 3.11–3.13.
- Your own Claude authentication. The straightforward setup below uses an **Anthropic API key** from the [Claude Console](https://platform.claude.com/), with billing available. See the [official Agent SDK setup](https://code.claude.com/docs/en/agent-sdk/quickstart) for supported authentication. Do not assume a consumer chat subscription includes API usage.

For rental campaigns, you also need your own public AppFolio listings page and a Zoho Campaigns account with a verified sender, mailing list, topic, and access to its MCP connection. “MCP” is the connection that lets the app ask Zoho to read information or save a draft. You supply that connection's address; the template does not create a Zoho MCP server.

All external accounts belong to you. Claude usage, hosting, and optional services may have their own charges. You can start with dashboard chat and add integrations as you need them.

## 1. Make your own copy

On [this repository](https://github.com/sirakinb/Email-Campaign-Agent), choose **Use this template → Create a new repository**. Give your copy a name, such as `my-email-agent`. Choose private if you do not want to share your code changes. This makes an independent copy; see [GitHub's template guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

Download your copy by running these commands, replacing `YOUR-USERNAME` and `my-email-agent` with your actual names:

```sh
git clone https://github.com/YOUR-USERNAME/my-email-agent.git
cd my-email-agent
```

If you just want to download this original repository first:

```sh
git clone https://github.com/sirakinb/Email-Campaign-Agent.git
cd Email-Campaign-Agent
```

Run the following commands from that project folder. These examples use macOS, Linux, or Windows with WSL. On Windows, install and run the prerequisites inside WSL too.

## 2. Install the project

```sh
npm install --global pnpm@9.15.0
pnpm install --frozen-lockfile
uv python install 3.12
uv sync --project pipelines --python 3.12 --frozen
```

Create an empty database using your local PostgreSQL installation:

```sh
createdb email_agent
```

If PostgreSQL asks for a username or password, use the credentials you chose when installing it. If `createdb` cannot connect, start PostgreSQL before continuing. Use a **new, empty database** for this application.

## 3. Add your private settings

```sh
cp .env.example .env
```

Open `.env` in a text editor. This is a private settings file: each line is a setting name followed by `=` and its value. Do not paste secrets into the README or commit `.env` to GitHub. The supplied ignore rules keep it out of normal commits.

Fill in these values:

| Setting | What to enter |
| --- | --- |
| `DATABASE_URL` | Keep `postgres://localhost/email_agent` if your local Postgres accepts your computer login. Otherwise use `postgres://YOUR_DB_USER:YOUR_DB_PASSWORD@localhost:5432/email_agent`. URL-encode special characters in database passwords. |
| `APP_PASSWORD` | A strong password you will use to open the dashboard. |
| `SESSION_SECRET` | A long random secret used to protect your login session. |
| `AGENT_TOKEN` | A different long random secret, shared by the server and worker so they can recognize each other. Required even for local worker use. |
| `ANTHROPIC_API_KEY` | Your own Claude API key. Only the worker needs it when you later split the services across machines. |
| `OWNER_EMAIL` | Your email address, used for test emails and recognizing inbound owner messages. |

Generate a random value for `SESSION_SECRET` and then run this command **again** for a different `AGENT_TOKEN`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep `PORT=8787` and `PUBLIC_URL=http://localhost:8787` for local use. Leave optional integrations blank for now. `AGENT_MODEL` selects the Claude model; use a model your account can access. The default is the model used by the original worker, not a guarantee of availability on every account.

## 4. Start the website and assistant

In the first terminal, from the project folder:

```sh
pnpm dev
```

Leave it running. Open **http://localhost:5173** and log in with your `APP_PASSWORD`. The server creates its database tables automatically on first startup. Empty campaign and analytics pages are expected until you connect and sync your own data.

Open a **second terminal**, go to the same project folder, and run:

```sh
pnpm dev:agent
```

Leave this terminal running too. Look for `Connected. Waiting for work.` Then open a new conversation in the dashboard and ask:

> What can you help me with, and which connections do I still need to set up?

A reply confirms the website, database, worker, and Claude authentication are working together. This step uses your Claude account. Stop either process with Ctrl+C when you are finished. Your database keeps the saved work.

## 5. Make it yours and connect your data

### Set your business details

Open **Settings → Branding** to change the displayed company name, product name, and accent color.

Open **Settings → Campaign setup** and enter your sender name, verified sender email, mailing list name and ID, topic name and ID, and public AppFolio listings URL. You can save partial setup and return later.

A list **name** is its readable label, such as “Leads.” A list **ID** is the identifier Zoho assigns it. Copy IDs as text exactly as Zoho provides them; do not use a list name in an ID field. Your topic must be set up in your Zoho account too. A Zoho administrator can help locate these details through the account or its API.

Your public listings URL usually looks like `https://YOUR-COMPANY.appfolio.com/listings/`. Use the public listing page, not the private AppFolio management login. This saved URL drives the importer.

### Connect Zoho Campaigns

1. Obtain your Zoho Campaigns MCP server URL from the service providing your Zoho MCP connection. The app expects Zoho's `ZohoCampaigns_*` tools; an unrelated connector URL will not work.
2. Put it in `ZOHO_CAMPAIGNS_MCP_URL` in `.env`.
3. Restart the first terminal's `pnpm dev` process so it reads the change.
4. In **Settings → Connections**, click **Connect** beside Zoho Campaigns and finish the sign-in in your browser. If the provider asks for a callback address, use `http://localhost:8787/oauth/callback` locally, or `https://YOUR-APP-DOMAIN/oauth/callback` when hosted. A provider that refuses localhost needs the hosted setup below.
5. Click **Sync now**. When it completes, check Campaigns and Analytics for your own history.

Zoho CRM is a separate optional connection: set `ZOHO_CRM_MCP_URL` and connect it separately. Connecting Zoho in another Claude app does not connect this dashboard.

### Try your first campaign

1. After syncing listings, ask: “Show me the current available homes.” Check that they belong to your business.
2. Ask: “Draft an email featuring two available homes. Save it for me to review.”
3. Read the email preview and ask for any changes.
4. If you configured AgentMail below, ask for a test email and approve it when prompted.
5. Ask to upload the draft to Zoho, approve the action, then open Zoho Campaigns to inspect it.
6. Send from Zoho only when you are ready.

Use **Settings → Guardrails** to choose which actions require approval. Scheduled planning and result reviews start paused on fresh installations; turn them on in **Settings → Automations** after the manual flow works. The data refresh runs daily. Schedules currently use **America/New_York** time.

## Optional connections

These are not needed for basic dashboard chat. Add their values to `.env` locally or the hosted server's variables, then restart that server.

| Feature | What to configure |
| --- | --- |
| Test emails and talking to the assistant by email | Create an [AgentMail](https://www.agentmail.to/) inbox. Set `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX` to its inbox ID, and `OWNER_EMAIL`. The app polls this inbox; only the configured owner's email can start work through it. |
| Talking by iMessage | Create a [Photon](https://photon.codes/) project with an assigned line. Set `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, and `OWNER_PHONE` including country code. The key needs project read/write access; platform read access lets Settings show the assigned line. Text that line first to opt in. |
| Gmail and additional apps | Set `COMPOSIO_API_KEY` from [Composio](https://composio.dev/) and `OWNER_EMAIL`. In **Settings → Apps → Add app**, choose and connect an app. Gmail profile/search/message reads can run directly; other connected-app actions follow the approval setting. |
| Generated images | Set `FAL_KEY` from [fal](https://fal.ai/). Review the image-generation guardrail before use. |
| Image hosting | Connect Cloudinary through Composio in Settings, or set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` from [Cloudinary](https://cloudinary.com/). |
| Managed remote worker and computer panel | Set up your own InstaBox computer using [the worker guide](docs/worker.md). |

## Put the website online

The included Dockerfile and `railway.toml` are set up for Railway. You can keep the worker running on your computer initially and move it later.

1. Make your own GitHub copy using Step 1 and create a [Railway](https://railway.com/) project. Add a service from your repository.
2. Add PostgreSQL to that same project. In your **application service**, add `DATABASE_URL` as a reference to the database service's `DATABASE_URL`. See [Railway's Postgres guide](https://docs.railway.com/databases/postgresql).
3. In the application service's variables, set `APP_PASSWORD`, `SESSION_SECRET`, `AGENT_TOKEN`, and `OWNER_EMAIL`, using fresh secrets. Add the integrations you want. Keep the Claude API key on the worker machine.
4. Generate a public domain for the application service and set `PUBLIC_URL` to that exact HTTPS address. Set `PORT=8787` and use that port for the generated domain.
5. Deploy or redeploy. The Dockerfile installs the application and Python importer and builds the website. Production mode is set in the image. `/health` is the health check. Keep **one replica** because scheduling and worker heartbeats live in one server process.
6. Open your new domain, log in, fill Campaign setup, and connect your accounts again. This is a new database: your local settings and connections are not copied automatically.
7. On the worker computer, set `SWITCHBOARD_URL` to your new HTTPS address and `AGENT_TOKEN` to the hosted server's matching token. Restart the worker. Follow [the worker guide](docs/worker.md) for a separate machine.

Your Railway website needs to stay running for schedules, inbound messages, and the worker to function. A sleeping laptop cannot act as an always-available worker. Back up your hosted database; it contains the work and account connections. Use separate databases and secrets for separate installations.

## If something does not work

| What you see | What to check |
| --- | --- |
| `command not found` | Install the named prerequisite and open a new terminal. Check `node --version`, `pnpm --version`, `uv --version`, and `psql --version`. |
| Database connection error | Start Postgres; confirm the database exists and `DATABASE_URL` uses the right user, password, and host. |
| Dashboard opens but messages wait | Start the worker in the second terminal; make sure the agent is enabled in Settings. |
| Worker receives 401 | `AGENT_TOKEN` must be nonempty and identical on the worker and server. |
| Worker receives 403 | When `INSTABOX_BOX_ID` is set on the server, the worker must send that same value as `AGENT_MACHINE_ID`. Leave both blank for local setup. |
| Claude authentication or model error | Check the worker's own API key, billing, and `AGENT_MODEL`; restart the worker after changes. |
| Zoho will not connect | Check the correct MCP URL, provider access, callback URL, and `PUBLIC_URL`; reconnect after changing domains. |
| No listings | Save your public AppFolio URL, then Sync now. The importer depends on AppFolio's page structure and may need updating if that structure changes. |
| Test email fails | AgentMail inbox/key and `OWNER_EMAIL` are required. A connected Gmail account is not the test-email sender. |
| Draft upload fails | Check the verified sender, list ID, and topic ID in Campaign setup, plus the Zoho connection. |
| Changed `.env`, nothing changed | Restart the relevant server or worker. Hosted settings must be changed in the hosting service too. |

## For people adapting the code

This is a single-owner application with one shared dashboard password, not a multi-customer service. Each business should run its own copy and database. Keep credentials and database backups private.

- `apps/web`: dashboard and settings screens.
- `apps/server`: API, approvals, integrations, scheduling, and database migrations.
- `apps/agent`: Claude worker and instructions. Edit `src/prompt.ts` to adapt its job to your business.
- `pipelines`: Python listing and campaign importer.
- `.env.example`: configuration reference with empty secrets.
- `docs/worker.md`: separate worker and InstaBox setup.

Changing branding alone does not change the rental-specific tools, listing importer, or email layout. To adapt another industry, start with the agent prompt, `pipelines/sources.py`, and `apps/server/src/services/emailTemplate.ts`. Changing campaign providers also requires replacing the Zoho tools and sync logic.

To check an installation or code change:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @ea/agent build
```

The normal build creates the website and server. The separate agent build creates the worker. The repository's automated tests cover selected behavior; they do not prove your external accounts can send mail or upload campaigns. Verify those using your own test draft.

## License

[Apache 2.0](LICENSE), preserving this repository's original license. Connected services have their own accounts, charges, and terms.
