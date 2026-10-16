import type { AppState, ChatDeleteMessageResult, ChatEvent, ChatRequest, ChatSession, ChatSessionSummary, HuggingFaceFile, HuggingFaceModel, McpServerInfo, McpServerSaveInput, NexusBridge, ProjectEntry, ProviderCatalogResult, ProviderInfo, RuntimeStatus, ToolApprovalChoice, UpdateStatus } from '../shared/types';
import { DEFAULT_SYSTEM_PROMPT } from '../shared/defaults';

const demoRuntime: RuntimeStatus = { running: false, message: 'Local runtime is available in the desktop app', baseUrl: 'http://127.0.0.1:8080/v1' };
const demoProviders: ProviderInfo[] = [
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'google', name: 'Google AI Studio', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'llamacpp', name: 'llama.cpp Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
];
const makeCatalogEntry = (id: string, name: string, baseUrl: string, freeTierHint?: string, kind: ProviderCatalogResult['entries'][number]['kind'] = 'openai-compatible') => ({ id, name, kind, baseUrl, modelCount: 0, freeModelCount: 0, freeTierHint, models: [] });
const demoCatalog: ProviderCatalogResult = {
  source: 'builtin',
  entries: [
    makeCatalogEntry('google', 'Google AI Studio', 'https://generativelanguage.googleapis.com/v1beta', 'Free tier on selected models; limits vary by project.', 'gemini'),
    makeCatalogEntry('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'Some models have free routes; current limits vary.'),
    makeCatalogEntry('groq', 'Groq', 'https://api.groq.com/openai/v1', 'Free developer tier available; model and rate limits vary.'),
    makeCatalogEntry('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
    makeCatalogEntry('mistral', 'Mistral AI', 'https://api.mistral.ai/v1'),
    makeCatalogEntry('togetherai', 'Together AI', 'https://api.together.xyz/v1'),
    makeCatalogEntry('fireworks-ai', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1'),
    makeCatalogEntry('deepinfra', 'Deep Infra', 'https://api.deepinfra.com/v1/openai'),
    makeCatalogEntry('huggingface', 'Hugging Face Inference', 'https://router.huggingface.co/v1', 'Small free credits may be available; check current terms.'),
    makeCatalogEntry('sambanova', 'SambaNova Cloud', 'https://api.sambanova.ai/v1'),
    makeCatalogEntry('perplexity', 'Perplexity', 'https://api.perplexity.ai'),
    makeCatalogEntry('xai', 'xAI', 'https://api.x.ai/v1'),
    makeCatalogEntry('nvidia', 'NVIDIA NIM', 'https://integrate.api.nvidia.com/v1'),
    makeCatalogEntry('ollama', 'Ollama (local)', 'http://127.0.0.1:11434/v1', 'Local inference; model runtime and hardware are yours.'),
    makeCatalogEntry('lmstudio', 'LM Studio (local)', 'http://127.0.0.1:1234/v1', 'Local inference; model runtime and hardware are yours.'),
  ],
};

let state: AppState = {
  desktop: false,
  providers: demoProviders,
  runtime: demoRuntime,
  mcpServers: [],
  sessionAllowedTools: [],
  settings: {
    theme: 'system', activeTab: 'chat', activeProviderId: 'llamacpp', activeModelId: '', contextTokens: 8192,
    maxOutputTokens: 4096, temperature: 0.2, enableTools: true, confirmToolCalls: true, allowShellWithoutProject: false, alwaysAllowTools: [], autoFetchModels: true, autoDiscoverProviders: true,
    zoomPercent: 100, providerCatalogUrl: 'https://models.dev/api.json', systemPrompt: DEFAULT_SYSTEM_PROMPT, activeProjectPath: '', hfTokenSet: false,
    localRuntime: { executablePath: '', modelPath: '', host: '127.0.0.1', port: 8080, contextTokens: 8192, gpuBackend: 'auto', gpuLayers: 99, deviceName: 'Vulkan0' },
  },
};
const chatListeners = new Set<(event: ChatEvent) => void>();
const downloadListeners = new Set<(data: { filename: string; received: number; total?: number; percent?: number }) => void>();
const logListeners = new Set<(line: string) => void>();
const runtimeStatusListeners = new Set<(status: RuntimeStatus) => void>();
const mcpServerListeners = new Set<(servers: McpServerInfo[]) => void>();
let demoSessions: ChatSession[] = [];
const emit = (event: ChatEvent) => chatListeners.forEach((listener) => listener(event));
const demoSessionSummaries = (): ChatSessionSummary[] => demoSessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, createdAt, updatedAt, providerId, modelId, messages }) => ({ id, title, createdAt, updatedAt, providerId, modelId, messageCount: messages.length }));
const mockModels = (providerId: string) => {
  const names: Record<string, string[]> = {
    openai: ['gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    anthropic: ['claude-sonnet-4', 'claude-3-7-sonnet-latest'],
    google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    openrouter: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'],
    llamacpp: ['qwen2.5-coder-14b-instruct', 'llama-3.1-8b-instruct'],
  };
  return (names[providerId] || ['example-model']).map((id) => ({ id, name: id, providerId, contextLength: 32768 }));
};
const updateState = (next: Partial<AppState>) => { state = { ...state, ...next }; return structuredClone(state); };

const demoBridge: NexusBridge = {
  previewMode: true,
  async getState() { return structuredClone(state); },
  async getUpdateStatus(): Promise<UpdateStatus> { return { state: 'unavailable', currentVersion: 'Preview', message: 'Software updates require the installed Windows desktop version.' }; },
  async checkForUpdates(): Promise<UpdateStatus> { return this.getUpdateStatus(); },
  async downloadUpdate(): Promise<UpdateStatus> { return this.getUpdateStatus(); },
  async installUpdate() { return undefined; },
  onUpdateStatus(_callback) { return () => {}; },
  async saveSettings(settings) { return updateState({ settings: { ...state.settings, ...settings, localRuntime: { ...state.settings.localRuntime, ...(settings.localRuntime || {}) } } }); },
  async saveProvider(input) {
    const existing = state.providers.find((item) => item.id === input.id);
    const provider: ProviderInfo = { id: input.id, name: input.name, kind: input.kind, baseUrl: input.baseUrl, hasKey: false, status: 'unknown', models: existing?.models || [], isPreset: existing?.isPreset || false, source: existing?.source || 'custom', docsUrl: existing?.docsUrl };
    const providers = existing ? state.providers.map((item) => item.id === provider.id ? provider : item) : [...state.providers, provider];
    updateState({ providers });
    return structuredClone(state);
  },
  async removeProvider(providerId) { updateState({ providers: state.providers.filter((provider) => provider.id !== providerId) }); return structuredClone(state); },
  async refreshModels(providerId) {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) return { state: structuredClone(state), error: 'Provider not found.' };
    const models = mockModels(providerId);
    updateState({ providers: state.providers.map((item) => item.id === providerId ? { ...item, status: 'active', lastChecked: new Date().toISOString(), models, lastError: undefined } : item) });
    return { state: structuredClone(state) };
  },
  async refreshAllModels() {
    updateState({ providers: state.providers.map((provider) => provider.hasKey || provider.id === 'llamacpp' ? { ...provider, status: 'active', models: mockModels(provider.id), lastChecked: new Date().toISOString() } : provider) });
    return structuredClone(state);
  },
  async getProviderCatalog(forceRefresh = false) {
    return structuredClone({ ...demoCatalog, fetchedAt: forceRefresh ? new Date().toISOString() : undefined });
  },
  async addCatalogProvider(providerId) {
    const entry = demoCatalog.entries.find((item) => item.id === providerId);
    if (!entry) return structuredClone(state);
    if (!state.providers.some((item) => item.id === providerId)) {
      updateState({ providers: [...state.providers, { ...entry, hasKey: false, status: 'unknown', models: entry.models, isPreset: false, source: 'catalog' }] });
    }
    return structuredClone(state);
  },
  async copyToClipboard(text) {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this preview.');
    await navigator.clipboard.writeText(text);
  },
  async getChatSessions() { return structuredClone(demoSessionSummaries()); },
  async getChatSession(sessionId) { return structuredClone(demoSessions.find((session) => session.id === sessionId) || null); },
  async saveChatSession(session) {
    const next = { ...structuredClone(session), updatedAt: Date.now() };
    const previous = demoSessions.find((item) => item.id === next.id);
    if (previous) next.createdAt = previous.createdAt;
    const firstUser = next.messages.find((message) => message.role === 'user')?.content.trim();
    if (firstUser) next.title = firstUser.replace(/\s+/g, ' ').slice(0, 100);
    demoSessions = [next, ...demoSessions.filter((item) => item.id !== next.id)].slice(0, 60);
    return structuredClone(demoSessionSummaries());
  },
  async deleteChatSession(sessionId) { demoSessions = demoSessions.filter((session) => session.id !== sessionId); return structuredClone(demoSessionSummaries()); },
  async deleteChatMessage(sessionId, messageId): Promise<ChatDeleteMessageResult> {
    const current = demoSessions.find((session) => session.id === sessionId);
    if (!current) return { session: null, sessions: demoSessionSummaries() };
    const messages = current.messages.filter((message) => message.id !== messageId);
    if (!messages.length) demoSessions = demoSessions.filter((session) => session.id !== sessionId);
    else demoSessions = demoSessions.map((session) => session.id === sessionId ? { ...session, messages, updatedAt: Date.now() } : session);
    return { session: structuredClone(demoSessions.find((session) => session.id === sessionId) || null), sessions: structuredClone(demoSessionSummaries()) };
  },
  async clearChatSessions() { demoSessions = []; return []; },
  async saveMcpServer(input: McpServerSaveInput) {
    const existing = state.mcpServers.find((server) => server.id === input.id);
    const server: McpServerInfo = {
      id: input.id, name: input.name, transport: input.transport, command: input.command, args: input.args || [], cwd: input.cwd, url: input.url,
      enabled: input.enabled ?? existing?.enabled ?? false, environmentKeys: Object.keys(input.environment || existing?.environmentKeys.reduce((result, key) => ({ ...result, [key]: '' }), {} as Record<string, string>) || {}),
      headerKeys: Object.keys(input.headers || existing?.headerKeys.reduce((result, key) => ({ ...result, [key]: '' }), {} as Record<string, string>) || {}),
      disabledTools: existing?.disabledTools || [], status: 'disconnected', tools: existing?.tools || [], resources: existing?.resources || [], prompts: existing?.prompts || [],
    };
    updateState({ mcpServers: existing ? state.mcpServers.map((item) => item.id === server.id ? server : item) : [...state.mcpServers, server] });
    mcpServerListeners.forEach((listener) => listener(state.mcpServers));
    return structuredClone(state);
  },
  async removeMcpServer(serverId) { updateState({ mcpServers: state.mcpServers.filter((server) => server.id !== serverId) }); return structuredClone(state); },
  async connectMcpServer() { return structuredClone(state); },
  async disconnectMcpServer(serverId) { updateState({ mcpServers: state.mcpServers.map((server) => server.id === serverId ? { ...server, enabled: false, status: 'disconnected' } : server) }); return structuredClone(state); },
  async refreshMcpServer() { return structuredClone(state); },
  async setMcpServerEnabled(serverId, enabled) { updateState({ mcpServers: state.mcpServers.map((server) => server.id === serverId ? { ...server, enabled, status: 'disconnected' } : server) }); return structuredClone(state); },
  async setMcpToolEnabled(serverId, toolKey, enabled) {
    updateState({ mcpServers: state.mcpServers.map((server) => server.id === serverId ? { ...server, disabledTools: enabled ? server.disabledTools.filter((key) => key !== toolKey) : [...new Set([...server.disabledTools, toolKey])] } : server) });
    return structuredClone(state);
  },
  onMcpServers(callback) { mcpServerListeners.add(callback); return () => mcpServerListeners.delete(callback); },
  async clearSessionPermissions() { updateState({ sessionAllowedTools: [] }); return structuredClone(state); },
  async setHuggingFaceToken() { return structuredClone(state); },
  async searchHuggingFace(query): Promise<HuggingFaceModel[]> {
    return [
      { id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', downloads: 142000, likes: 510, tags: ['gguf', 'qwen', 'code', 'text-generation'] },
      { id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', downloads: 375000, likes: 920, tags: ['gguf', 'llama', 'text-generation'] },
      { id: 'unsloth/DeepSeek-Coder-V2-Lite-Instruct-GGUF', downloads: 73000, likes: 340, tags: ['gguf', 'deepseek', 'code'] },
    ].filter((item) => !query || item.id.toLowerCase().includes(query.toLowerCase()));
  },
  async getHuggingFaceFiles(repoId): Promise<HuggingFaceFile[]> {
    return [
      { name: 'Q4_K_M.gguf', size: 0, downloaded: false },
      { name: 'Q5_K_M.gguf', size: 0, downloaded: false },
    ].map((file) => ({ ...file, name: `${repoId.split('/').at(-1)}-${file.name}` }));
  },
  async downloadHuggingFaceFile(repoId, filename) { return `C:/Users/you/AppData/Roaming/nexus-studio/models/${repoId}/${filename}`; },
  async openProject() { return null; },
  async listProjectFiles(): Promise<ProjectEntry[]> { return []; },
  async readProjectFile() { return ''; },
  async writeProjectFile() {},
  async getProjectPreviewUrl() { return 'about:blank'; },
  async updateProjectPreview() { return 'about:blank'; },
  async runShellCommand(command) { return { output: `Desktop preview only — shell command not executed:\n${command}`, exitCode: null }; },
  async setRuntimePath() { return null; },
  async setLocalModelPath() { return null; },
  async selectLocalModel(modelPath) { updateState({ settings: { ...state.settings, localRuntime: { ...state.settings.localRuntime, modelPath } } }); return structuredClone(state); },
  async startLocalRuntime() { updateState({ runtime: { ...demoRuntime, message: 'Available in the desktop app' } }); return structuredClone(state); },
  async stopLocalRuntime() { updateState({ runtime: demoRuntime }); return structuredClone(state); },
  async startChat(request: ChatRequest, suppliedRequestId?: string) {
    const requestId = suppliedRequestId || crypto.randomUUID();
    const answer = 'This is a live UI preview, not a model response. In the Windows desktop build, add a provider key in Settings → Providers (or select a GGUF model under Models → Local), then your prompts stream directly from that model. Shell and file tools stay behind explicit approval, and credentials are encrypted with Windows secure storage.';
    let index = 0;
    const tick = () => {
      const part = answer.slice(index, index + 5);
      index += part.length;
      if (part) emit({ requestId, type: 'delta', text: part });
      if (index < answer.length) setTimeout(tick, 22);
      else emit({ requestId, type: 'done' });
    };
    setTimeout(tick, 240);
    return requestId;
  },
  onChatEvent(callback) { chatListeners.add(callback); return () => chatListeners.delete(callback); },
  cancelChat(requestId) { emit({ requestId, type: 'done', cancelled: true }); },
  async respondToTool(_toolId: string, _decision: ToolApprovalChoice) { return structuredClone(state); },
  async answerQuestion(_questionId: string, _answer: string) { return undefined; },
  onDownloadProgress(callback) { downloadListeners.add(callback); return () => downloadListeners.delete(callback); },
  onRuntimeLog(callback) { logListeners.add(callback); return () => logListeners.delete(callback); },
  onRuntimeStatus(callback) { runtimeStatusListeners.add(callback); return () => runtimeStatusListeners.delete(callback); },
  async getLocalModels() { return []; },
};

export const bridge = window.nexus || demoBridge;
