# Nexus Studio

A polished desktop AI workbench for hosted APIs and local GGUF models. Nexus is an orchestration shell—not a bundled foundation model—so model knowledge and quality come from the provider or local weights you choose.

## What is included

- **Streaming chat and history:** server-sent-event token streaming for OpenAI-compatible APIs (including OpenRouter and llama.cpp), Anthropic Messages, and Google Gemini. Conversations save locally, reopen from the sidebar, and can be deleted by message, session, or all at once.
- **Live model discovery:** fetches models from configured endpoints on demand and, by default, refreshes connected providers on app startup. The chat header and persistent model picker both have a visible **Fetch models** action.
- **Provider directory:** a cached, refreshable models.dev-compatible catalog discovers supported OpenAI-compatible, Anthropic, and Gemini APIs. It includes no-cost model metadata where available, plus built-in choices for popular hosted and local endpoints. Add a directory entry to put it in the provider/model pickers; custom endpoints remain available too. Free access and rate limits are determined by each provider and can change.
- **Provider management:** OpenAI, Anthropic, Google AI Studio, OpenRouter, Groq, Cerebras, Mistral, Together AI, Fireworks, Deep Infra, Hugging Face Inference, and many more compatible catalog entries, plus Ollama/LM Studio local endpoints and custom URLs. API keys are optional for endpoints that do not require them.
- **Agent tools:** 12 direct tools for project read/write/edit/glob/grep, shell, public web fetch/search, user questions, reusable skills, child-model delegation, and restricted Code Mode. Tool requests and results are shown in chat; reasoning streams into its own collapsible panel when the provider exposes it. Approvals support once/session/always per tool.
- **Shell without a project:** optionally enable shell commands when no project is open. They start in the user home folder, can list drives, and remain approval-gated by default. Read/write project tools are not offered until a project is open.
- **MCP plugins:** local stdio servers, remote Streamable HTTP, and legacy SSE; custom environment variables/HTTP headers use OS-backed encryption. Connected capabilities are called in restricted Code Mode as `tools.<server-id>.<method>(...)`, with each nested operation independently approved. Playwright and Context7 presets are included.
- **Project workspace:** browse and edit local files, save changes, run confirmed commands, and open project HTML in a side-by-side responsive preview (fluid, laptop, tablet, and mobile widths). The in-app preview serves project files read-only in a sandbox with external network requests blocked.
- **GGUF model discovery:** search Hugging Face GGUF repositories, select a quantization file, download with progress, and use it with llama.cpp.
- **Local inference controls:** select a `llama-server` executable and GGUF, configure context length, port, GPU layers and CPU/Auto/Vulkan/CUDA device options, then start or stop the local server.
- **Settings:** system/dark/light themes, saved interface zoom (Ctrl +/−/0), model defaults, context/output controls, automatic provider/model discovery, editable system instructions, per-tool approval rules, MCP server management, local runtime options, and an optional encrypted Hugging Face token. The layout adapts to narrow screens.

## Run in development

Requirements: **Node.js 22.12 or newer** and npm.

```powershell
npm ci
npm run dev
```

`npm run dev` launches the Vite renderer and the Electron desktop shell. To preview only the UI in a browser, use `npm run web`; browser preview mode deliberately simulates chat responses and does not store API keys or execute shell commands.

## Build the Windows executable

On Windows (recommended):

```powershell
npm ci
npm run pack:win
```

The updater-ready installer target is named `Nexus-Studio-Setup-0.4.4-x64.exe` when built on Windows. Nexus checks for updates from the public `LinusOS400/Nexus-Ai` GitHub Releases feed. The portable target remains available with `npm run pack:win:portable`, but portable builds cannot safely replace themselves; install the NSIS setup build once to use **Settings → Updates**. Builds are currently unsigned, so Windows SmartScreen may show a first-run warning.

## In-app updates and publishing

In the installed Windows build, open **Settings → Updates**, check for a release, download it, then choose **Install & restart**. Nexus does not install updates without your approval. The updater only needs public release metadata and installer assets; no GitHub key is embedded in the app.

The GitHub Actions workflow at `.github/workflows/publish-windows-release.yml` builds and publishes the NSIS installer, `latest.yml`, and blockmap when a version tag such as `v0.4.4` is pushed. It can also be run manually from the repository’s **Actions** tab. It uses the repository-scoped `GITHUB_TOKEN` with `contents: write`; do not put a personal token in source or in the app. Before the first release, the project source and workflow must be present in the GitHub repository. For later releases, update `package.json`'s version and either push the matching `vX.Y.Z` tag or run the workflow manually; it publishes the update feed.

## Chat code blocks

Fenced Markdown source is rendered in a syntax-colored, scrollable code panel. Each block has one-click **Copy** and **Download** controls; common languages and formats such as HTML, CSS, JavaScript/TypeScript, Python, C/C++, Java, Go, Rust, JSON, YAML, SQL, shell, and Markdown are supported. The default assistant prompt asks for labeled code fences so source is kept separate from explanatory text.

## Connect a hosted model

1. Open **Settings → Providers → Discover providers** to search the live directory, filter for free/no-cost catalog entries, and add a compatible provider; or choose **Add provider** for a custom endpoint.
2. Add the provider's API key if required. Keys are saved via Electron's OS-backed `safeStorage` (Windows uses DPAPI); the renderer receives only a `hasKey` flag.
3. Use **Fetch models** in the chat header or sidebar model picker to sync that provider's current API model list. The provider/model pickers update immediately when a directory provider is added.
4. Send a prompt. The desktop main process makes the provider request and streams text chunks into the conversation.

The directory defaults to `https://models.dev/api.json`; it refreshes automatically when enabled and keeps a local cache for offline use. The source URL can be changed in **Settings → Advanced**. Catalog pricing of zero does not guarantee free API access, and upstream quotas/terms can change.

For custom OpenAI-compatible services, enter the base API URL, commonly ending in `/v1`. Custom public endpoints must use HTTPS. HTTP is accepted for loopback or private-network endpoints (RFC1918 IPv4 and IPv6 ULA) such as a local inference server.

## MCP plugins and browser automation

Open **Settings → Tools & safety → MCP servers** to add a local stdio command or remote Streamable HTTP / legacy SSE server. Local command and arguments are launched directly (not through a shell); remote endpoints can use encrypted custom headers. After you explicitly connect, Nexus discovers tools, prompts, and resources. When agent tools are enabled, the provider receives a restricted Code Mode tool and the model can call connected capabilities as `tools.<server-id>.<method>(...)`; each nested capability is checked for connection state and independently approval-gated. Disable individual capabilities in the server card, and use once/session/always approval choices in chat. Saving or removing a server clears its session and persistent MCP allow rules.

The built-in direct-tool set is the 12 tools listed above. The broader `browser`, `context7`, `gh_grep`, `master_builder_memory`, `opencode`, and `playwright` namespaces are **not bundled services**: they become available only when you connect a matching MCP server that actually advertises those methods. The presets provide Playwright browser automation and Context7 documentation lookup; Nexus does not claim every method in a third-party inventory is present or tested.

The Playwright preset uses `npx -y @playwright/mcp@latest`. Connecting it downloads/runs the package through npm, so review and trust the package before connecting. The Context7 preset points to `https://mcp.context7.com/mcp`; add an encrypted `CONTEXT7_API_KEY` header if you need higher rate limits. MCP server processes are **not sandboxed** and run with your OS account permissions. OAuth authorization flows are not included in this build; use a remote server's custom header authentication where supported.

## Project HTML preview

In **Workspace**, open an `.html` or `.htm` file and choose **Preview** to display the project page beside the editor. Use the device controls for fluid desktop, 1280 px laptop, 768 px tablet, or 390 px mobile widths. The active unsaved HTML editor contents are reflected in the preview; local project assets are served read-only from the selected root. The iframe runs in an isolated custom protocol with a restrictive content-security policy; external network requests are blocked.

The embedded panel is a static local-file preview, not a full dev-server proxy. For browser automation against a running web app or localhost dev server, connect the Playwright MCP preset and direct its browser tools to your local URL; tool calls still require approval unless you explicitly create a per-tool allow rule.

## Run a local GGUF model

Nexus does **not** bundle `llama-server.exe` or a GGUF model. This avoids shipping a GPU-specific runtime and gives you control over the model and license.

1. Install a `llama-server` build compatible with your system. For Vulkan, choose a llama.cpp build compiled with Vulkan support; GPU names/options depend on that build.
2. In **Model library → Local GGUF**, search Hugging Face, choose a repository/file and start the download, or select a GGUF already on disk.
3. In **Settings → Local runtime**, select `llama-server.exe`, set context length and GPU options, then start the runtime.
4. Once the local API is healthy, its models appear under the llama.cpp provider. Choose one from the top-bar model selector.

Nexus binds the local server to `127.0.0.1`. Vulkan mode passes the configured device name (default `Vulkan0`) through llama.cpp's `--device`; adjust it to match the selected build/device. `CPU only` forces zero GPU layers.

## Security and data boundaries

- Provider credentials and Hugging Face tokens are encrypted in Electron's OS-backed secure store. The app never returns secret values to the renderer.
- Hosted prompts are sent to the provider you select and are subject to that provider's policies. No training data or model weights are included in this repository.
- App file reads/writes are constrained to the open project path; symbolic-link paths are rejected. The editor/tool read limits are 1 MB per file; tool writes are limited to 2 MB.
- Shell commands start in the project folder and have a 60-second timeout and capped output. Shell-without-project access is off by default; explicitly enabling it starts commands in the home folder. Shell is **not an OS sandbox**: it can access anything your Windows account can access. Every tool approval choice is per-tool; persistent rules are visible and revocable in Settings.
- Local MCP commands and their tools are not sandboxed. Connect only servers you trust; their processes have your account's filesystem and network permissions. MCP environment values and remote headers are encrypted via OS-backed secure storage and never returned to the renderer.
- The HTML preview uses an app-only protocol, a session token, project-root/symlink checks, read-only file serving, an isolated iframe, and a restrictive CSP that blocks external network requests.
- GGUF downloads happen only after a repository file is explicitly selected. llama.cpp runtimes and MCP servers are never launched automatically unless you choose Connect or Start.
- Conversation transcripts are saved locally in Electron's user-data directory so they can be reopened after restart. Delete a message, a full session, or all saved conversations from the UI; transcripts are not sent anywhere beyond the AI provider/model you choose.

## Project layout

```text
src/             React + TypeScript UI
shared/          Shared app/provider/chat types
electron/        Main process, secure preload, provider adapters, settings store
assets/          Nexus app icon
```

## Notes

This is an initial functional harness and UI foundation. Provider APIs differ in available models, token limits, tool-call compatibility, and local runtime flags; endpoint errors are surfaced in the provider card. The installed runtime and selected GGUF must fit the user's hardware and model license.
