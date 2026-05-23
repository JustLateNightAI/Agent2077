# Agent2077

Agent2077 is a self-hosted AI agent workspace for running local and OpenAI-compatible models with real tools. It gives you a browser UI where an agent can chat, inspect projects, write code, run commands, remember context, use skills, and deploy Docker-backed apps from one local machine.

You are fully responible for anything that happens by you installing and using this tool.

If this agent is useful to you, feel free to help support its further development :D
https://ko-fi.com/latenightai
(current costs spent on development: $1,283.46 USD)

My random neglected Discord: https://discord.gg/3yTAQ4xEAr
Maybe I'll answer your questions, maybe I wont, depends on my coffee supply.

![Agent2077 chat home](docs/screenshots/chat-home.png)

## Highlights

- **Linux only but accessable from windows and Mac**: Agent2077 only runs on linux, but since it local hosts a webui you can use it from a windows or mac PC.
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
in the main folder where the install.sh is, open a terminal and run ./install.sh
After install you can launch it again by opening the terminal and running ./start.sh
```
(When serving on the local network it is your job to make sure it is safe and secure, I do not recomend doing this on public wifi, only on your own private wifi or lan.)


Open:

```text
when serving on the local network it should host to agent2077.local
(deviceIP:5000) or from the host machine http://localhost:5000
```

Default login:

```text
Username: Agent2077
Password: Agent2077
```

Change the default password in **Settings → Security** before exposing the app to a network.

## Production build


By default the server binds to localhost. Enable LAN serving from **Settings → Network** if you want access from other machines on your network.


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


## Security notes

Agent2077 can execute commands, edit files, connect to model endpoints, and deploy containers. Treat it like a local developer tool with real system access.

- Change the default password immediately.
- Keep LAN serving disabled unless you need it.
- Use a strong `JWT_SECRET` in production.
- Review model endpoint keys and Docker access before sharing a machine.
- Do not expose the server directly to the public internet without a proper reverse proxy and authentication hardening.

## Status

Agent2077 is under active development by LateNightAI. Expect inconstant Development and sporadic fixes and feature additions. If there's something you really want added to Agent2077 then either wait for me to add it or do it yourself using the Self Dev mode.

## Useful info rambling from me the Dev :D

I built agent2077 to be modular and useful for coding and making things. I was also making some stuff for it to be useful in chatting and image gen/editing via comfyui but ended up spending most of my time working on the self dev and workspace, and app store. I mostly developed around using LM Studio for local models. If you enable more than one model in the model selector for lm studio, in theory it should load and unload models according to when tasks tags you assign to the models. IE, you turn on Qwen3.6 27B and give it the coding tag, and you turn on gemma4 31B and give it the research tag. It should then load the gemma model to do research, then when given a coding task, unload the gemma model to free the vram, and load the qwen3.6 37B model to do coding. 
For the app store its mostly meant for webapps, and will require docker to be setup. but the basics of it is, in the normal chat you ask it to build you an app and add it to the app store. IE, "build me a flappy birds game and add it to the app store" then (if the model your using is good enough) it will code up a flappy birds like game and add it to the app store where you can launch it and play it. 
Hopefully soon if I'm motivated enough I'll make an indepth video on how to setup and use Agent2077 and throw it up and YouTube and I'll link it here if/when I do.


## License

Agent2077 is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, contact JustLateNightAI@gmail.com.
