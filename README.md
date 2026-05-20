# Agent2077

Agent2077 is a self-hosted AI agent workspace for running local and OpenAI-compatible models with real tools. It gives you a browser UI where an agent can chat, inspect projects, write code, run commands, remember context, use skills, and deploy Docker-backed apps from one local machine.

You are fully responible for anything that happens by you installing and using this tool.

If this agent is useful to you, feel free to help support its further development :D
https://ko-fi.com/latenightai
(current costs spent on development: $1,083.46)

My random neglected Discord: https://discord.gg/3yTAQ4xEAr
Maybe I'll answer your questions, maybe I wont, depends on my coffee supply.

![Agent2077 chat home](docs/screenshots/chat-home.png)

## Highlights

- **Linus only but accessable from windows and Mac**: Agent2077 only runs on linux, but since it local hosts a webui you can use it from a windows or mac PC.
- **Local-first agent loop**: run against LM Studio, OpenRouter, or any generic OpenAI-compatible `/v1/chat/completions` endpoint.
- **Smart tool selection**: sends only the tools relevant to the current task instead of dumping every tool schema into every request.
- **Tool discovery on demand**: `tool_list` and `tool_search` let the agent browse the full tool catalogue without bloating the system prompt.
- **Project workspace**: create or open coding projects, let the agent read/edit files, and keep project-specific context separate from normal chat.
- **Docker app deployment**: build and manage generated web apps, tools, and games from the built-in App Store.
- **Persistent memory and skills**: store reusable knowledge, search memory, and maintain task-specific skill instructions.
- **Multi-model orchestration**: register multiple endpoints and models, mark orchestrators, assign task types, and benchmark model behavior.
- **Reliability guards**: deterministic request routing, malformed tool-call repair, targeted failure nudges, and an adjustable failed-tool-call cap.
- **Self-dev mode**: optional tools for Agent2077 to inspect and improve its own codebase.

## Screenshots

| Chat | Workspace |
|---|---|
| ![Chat home](docs/screenshots/chat-home.png) | ![Coding workspace](docs/screenshots/workspace.png) |

| App Store | Skills |
|---|---|
| ![App Store](docs/screenshots/app-store.png) | ![Skills](docs/screenshots/skills.png) |

| API endpoints and settings |
|---|
| ![API endpoint settings](docs/screenshots/settings-api-endpoints.png) |

## Requirements

- Node.js 22+
- SQLite, bundled through `better-sqlite3`
- Docker, optional but recommended for code execution and app deployment
- At least one LLM endpoint:
  - LM Studio local server
  - OpenRouter
  - any OpenAI-compatible `/v1/chat/completions` endpoint

Agent2077 can start without Docker, but code execution and app deployment are disabled until Docker is available.

## Quick start
Agent2077 is meant to be run on its own linux machine and server on the local network.

```bash
git clone https://github.com/JustLateNightAI/Agent2077.git agent2077
cd agent2077
npm install
npx tsx script/build.ts
NODE_ENV=production node dist/index.cjs

add the "--listen flag" to have it start serving on the local network.
```

Open:

```text
http://localhost:5000
it when serving on the local network it should host to agent2077.local
(deviceIP:5000)
```

Default login:

```text
Username: Agent2077
Password: Agent2077
```

Change the default password in **Settings → Security** before exposing the app to a network.

## Production build

```bash
NODE_ENV=production node dist/index.cjs

```

By default the server binds to localhost. Enable LAN serving from **Settings → Network** if you want access from other machines on your network.
Or launch Agent2077 from the terminal with the --listen flag: NODE_ENV=production node dist/index.cjs --listen

## Configure a model endpoint

Go to **Settings → API Endpoints** and add one of:

- **LM Studio**: usually `http://localhost:1234`
- **OpenRouter**: `https://openrouter.ai/api/v1`
- **OpenAI Compatible**: any provider or local gateway exposing `/v1/chat/completions`

After adding an endpoint, click sync to discover models. Enable one or more models, then choose which models support tool calling, vision, orchestration, or sub-agent work.

## How Agent2077 works

```text
Browser UI
   │
   ▼
Express API
   │
   ├── Agent loop
   │     ├── request router
   │     ├── compact system prompt
   │     ├── smart tool selector
   │     ├── tool-call repair
   │     └── failure classifier
   │
   ├── Tool registry
   ├── Project workspace
   ├── Memory and skills
   ├── Docker app manager
   └── SQLite database
```

The current prompt/tool pipeline is designed to keep local models responsive:

1. Classify the request with a deterministic router.
2. Build a compact system prompt with only relevant modules.
3. Select a small tool subset for the current route, plan, model, and project mode.
4. Repair malformed tool calls before execution when possible.
5. Inject targeted recovery guidance for repeated failures.

## Important settings

- **Smart tool selection**: enabled by default. Set `smart_tool_selection` to `"false"` to send the full tool registry.
- **Max consecutive failed tool calls**: configurable in Settings. Backend key: `agent.maxFailedToolCalls`.
- **Internet kill switch**: disables outbound web/search tools while keeping local tools available.
- **OpenRouter balance floor**: optional per-endpoint spend guard.
- **LAN serving**: disabled by default for safety.

## Project structure

```text
client/                 React frontend
server/                 Express API, agent loop, tools, storage
server/lib/             core agent modules
server/tools/           registered tools
shared/                 shared database schema and types
script/                 build and smoke-test scripts
data/                   local SQLite database, memory files
docs/screenshots/       README screenshots
```

## Useful scripts

```bash
npm run dev       # development server
npm run build     # production client + server bundle
npm start         # run built server
npm run db:studio # open Drizzle Studio
```

Additional smoke tests live in `script/`, including tool selector, tool discovery, router, repair, and failure-classifier checks.

## Security notes

Agent2077 can execute commands, edit files, connect to model endpoints, and deploy containers. Treat it like a local developer tool with real system access.

- Change the default password immediately.
- Keep LAN serving disabled unless you need it.
- Use a strong `JWT_SECRET` in production.
- Review model endpoint keys and Docker access before sharing a machine.
- Do not expose the server directly to the public internet without a proper reverse proxy and authentication hardening.

## Status

Agent2077 is under active development. Expect fast iteration around local-model reliability, tool routing, project workflows, and app deployment.

## License

Agent2077 is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, contact JustLateNightAI@gmail.com.
