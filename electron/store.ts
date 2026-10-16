import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, AppState, McpServerConfig, McpServerInfo, McpServerSaveInput, ModelInfo, ProviderInfo, ProviderKind, RuntimeStatus } from '../shared/types';
import { DEFAULT_SYSTEM_PROMPT } from '../shared/defaults';

export const DEFAULT_PROVIDERS: ProviderInfo[] = [
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'google', name: 'Google AI Studio', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
  { id: 'llamacpp', name: 'llama.cpp Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', hasKey: false, status: 'unknown', models: [], isPreset: true, source: 'builtin' },
];

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  activeTab: 'chat',
  activeProviderId: 'llamacpp',
  activeModelId: '',
  contextTokens: 8192,
  maxOutputTokens: 4096,
  temperature: 0.2,
  enableTools: true,
  confirmToolCalls: true,
  allowShellWithoutProject: false,
  alwaysAllowTools: [],
  autoFetchModels: true,
  autoDiscoverProviders: true,
  zoomPercent: 100,
  providerCatalogUrl: 'https://models.dev/api.json',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  activeProjectPath: '',
  hfTokenSet: false,
  localRuntime: {
    executablePath: '',
    modelPath: '',
    host: '127.0.0.1',
    port: 8080,
    contextTokens: 8192,
    gpuBackend: 'auto',
    gpuLayers: 99,
    deviceName: 'Vulkan0',
  },
};

interface DiskState {
  version: 1;
  settings: AppSettings;
  providers: Array<Omit<ProviderInfo, 'hasKey'>>;
  encryptedSecrets: Record<string, string>;
  encryptedHfToken?: string;
  mcpServers: McpServerConfig[];
}

export class StateStore {
  private state: DiskState;
  private readonly filePath: string;
  private readonly secrets: Record<string, string> = {};
  private hfToken = '';

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'nexus-state.json');
    this.state = this.read();
    this.decryptStoredSecrets();
  }

  private read(): DiskState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<DiskState>;
      const savedProviders = Array.isArray(raw.providers) ? raw.providers : [];
      const providers = DEFAULT_PROVIDERS.map((preset) => {
        const existing = savedProviders.find((item) => item.id === preset.id);
        return existing ? { ...preset, ...existing, hasKey: false } : { ...preset, hasKey: false };
      });
      for (const custom of savedProviders) {
        if (!DEFAULT_PROVIDERS.some((preset) => preset.id === custom.id)) providers.push({ ...custom, hasKey: false, isPreset: false } as ProviderInfo);
      }
      const rawMcpServers = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
      const mcpServers = rawMcpServers.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string').map((item) => ({
        id: String(item.id).slice(0, 50),
        name: String(item.name).slice(0, 80),
        transport: (['stdio', 'streamable-http', 'sse'].includes(item.transport) ? item.transport : 'stdio') as McpServerConfig['transport'],
        command: typeof item.command === 'string' ? item.command.slice(0, 500) : undefined,
        args: Array.isArray(item.args) ? item.args.filter((arg: unknown): arg is string => typeof arg === 'string').slice(0, 100).map((arg: string) => arg.slice(0, 1000)) : [],
        cwd: typeof item.cwd === 'string' ? item.cwd.slice(0, 2000) : undefined,
        url: typeof item.url === 'string' ? item.url.slice(0, 2000) : undefined,
        enabled: item.enabled === true,
        environmentKeys: Array.isArray(item.environmentKeys) ? item.environmentKeys.filter((key: unknown): key is string => typeof key === 'string').slice(0, 100) : [],
        headerKeys: Array.isArray(item.headerKeys) ? item.headerKeys.filter((key: unknown): key is string => typeof key === 'string').slice(0, 100) : [],
        disabledTools: Array.isArray(item.disabledTools) ? item.disabledTools.filter((key: unknown): key is string => typeof key === 'string').slice(0, 300) : [],
      } as McpServerConfig));
      const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}), localRuntime: { ...DEFAULT_SETTINGS.localRuntime, ...(raw.settings?.localRuntime || {}) } };
      settings.allowShellWithoutProject = raw.settings?.allowShellWithoutProject === true;
      settings.alwaysAllowTools = Array.isArray(raw.settings?.alwaysAllowTools) ? raw.settings.alwaysAllowTools.filter((key: unknown): key is string => typeof key === 'string' && key.length <= 4096).slice(0, 500) : [];
      return {
        version: 1,
        settings,
        providers: providers as Array<Omit<ProviderInfo, 'hasKey'>>,
        encryptedSecrets: raw.encryptedSecrets || {},
        encryptedHfToken: raw.encryptedHfToken,
        mcpServers,
      };
    } catch {
      return { version: 1, settings: { ...DEFAULT_SETTINGS, localRuntime: { ...DEFAULT_SETTINGS.localRuntime } }, providers: DEFAULT_PROVIDERS.map(({ hasKey: _hasKey, ...p }) => p), encryptedSecrets: {}, mcpServers: [] };
    }
  }

  private decryptStoredSecrets() {
    if (!safeStorage.isEncryptionAvailable()) return;
    for (const [id, encrypted] of Object.entries(this.state.encryptedSecrets || {})) {
      try { this.secrets[id] = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { /* The OS key may have changed; ask for the key again. */ }
    }
    if (this.state.encryptedHfToken) {
      try { this.hfToken = safeStorage.decryptString(Buffer.from(this.state.encryptedHfToken, 'base64')); } catch { this.hfToken = ''; }
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  getSecret(id: string) { return this.secrets[id] || ''; }
  getHfToken() { return this.hfToken; }

  getState(runtime: RuntimeStatus, mcpServers: McpServerInfo[] = []): AppState {
    const providers: ProviderInfo[] = this.state.providers.map((provider) => ({
      ...provider,
      hasKey: Boolean(this.secrets[provider.id]),
      models: (provider.models || []) as ModelInfo[],
    }));
    return {
      settings: { ...this.state.settings, alwaysAllowTools: [...this.state.settings.alwaysAllowTools], hfTokenSet: Boolean(this.hfToken) },
      providers,
      runtime,
      mcpServers: mcpServers.map((server) => ({ ...server, args: [...server.args], environmentKeys: [...server.environmentKeys], headerKeys: [...server.headerKeys], disabledTools: [...server.disabledTools] })),
      sessionAllowedTools: [],
      desktop: true,
    };
  }

  updateSettings(patch: Partial<AppSettings>) {
    const safePatch = { ...patch };
    delete safePatch.hfTokenSet;
    if (safePatch.alwaysAllowTools !== undefined) {
      safePatch.alwaysAllowTools = Array.isArray(safePatch.alwaysAllowTools) ? [...new Set(safePatch.alwaysAllowTools.filter((key) => typeof key === 'string').map((key) => key.slice(0, 4096)))].slice(0, 500) : this.state.settings.alwaysAllowTools;
    }
    if (safePatch.allowShellWithoutProject !== undefined && typeof safePatch.allowShellWithoutProject !== 'boolean') delete safePatch.allowShellWithoutProject;
    this.state.settings = {
      ...this.state.settings,
      ...safePatch,
      localRuntime: { ...this.state.settings.localRuntime, ...(safePatch.localRuntime || {}) },
    };
    this.persist();
  }

  upsertProvider(provider: { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; clearKey?: boolean; docsUrl?: string; source?: 'builtin' | 'catalog' | 'custom' }) {
    if (provider.apiKey?.trim() && !safeStorage.isEncryptionAvailable()) throw new Error('Secure key storage is unavailable. Use the installed desktop app on Windows to save API keys.');
    const idx = this.state.providers.findIndex((item) => item.id === provider.id);
    const existing = idx >= 0 ? this.state.providers[idx] : undefined;
    const clean: Omit<ProviderInfo, 'hasKey'> = {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      status: existing?.status || 'unknown',
      lastChecked: existing?.lastChecked,
      lastError: existing?.lastError,
      models: existing?.models || [],
      isPreset: Boolean(existing?.isPreset),
      source: provider.source || existing?.source || (existing?.isPreset ? 'builtin' : 'custom'),
      docsUrl: provider.docsUrl || existing?.docsUrl,
    };
    if (idx >= 0) this.state.providers[idx] = clean;
    else this.state.providers.push(clean);
    if (provider.clearKey) {
      delete this.secrets[provider.id];
      delete this.state.encryptedSecrets[provider.id];
    }
    if (provider.apiKey?.trim()) {
      this.secrets[provider.id] = provider.apiKey.trim();
      this.state.encryptedSecrets[provider.id] = safeStorage.encryptString(provider.apiKey.trim()).toString('base64');
    }
    this.persist();
  }

  seedProviderModels(id: string, models: ModelInfo[]) {
    const provider = this.state.providers.find((item) => item.id === id);
    if (!provider) throw new Error('Provider not found.');
    provider.models = models.slice(0, 120).map((model) => ({ ...model, providerId: id }));
    this.persist();
  }

  removeProvider(id: string) {
    if (DEFAULT_PROVIDERS.some((provider) => provider.id === id)) throw new Error('Built-in providers cannot be removed. You can clear their key or edit their endpoint.');
    this.state.providers = this.state.providers.filter((provider) => provider.id !== id);
    delete this.secrets[id];
    delete this.state.encryptedSecrets[id];
    if (this.state.settings.activeProviderId === id) {
      this.state.settings.activeProviderId = 'llamacpp';
      this.state.settings.activeModelId = '';
    }
    this.persist();
  }

  updateProviderModels(id: string, models: ModelInfo[], status: 'active' | 'inactive', error?: string) {
    const provider = this.state.providers.find((item) => item.id === id);
    if (!provider) throw new Error('Provider not found.');
    const catalogModels = new Map((provider.models || []).map((model) => [model.id, model]));
    provider.models = models.map((model) => ({ ...catalogModels.get(model.id), ...model, providerId: id }));
    provider.status = status;
    provider.lastChecked = new Date().toISOString();
    provider.lastError = error;
    this.persist();
  }

  private mcpSecretKey(serverId: string, kind: 'env' | 'header', name: string) {
    return `mcp:${serverId}:${kind}:${name}`;
  }

  getMcpServers(): McpServerConfig[] {
    return this.state.mcpServers.map((server) => ({ ...server, args: [...server.args], environmentKeys: [...server.environmentKeys], headerKeys: [...server.headerKeys], disabledTools: [...server.disabledTools] }));
  }

  getMcpServer(serverId: string) {
    return this.state.mcpServers.find((server) => server.id === serverId);
  }

  getMcpServerLaunchConfig(serverId: string) {
    const config = this.getMcpServer(serverId);
    if (!config) throw new Error('MCP server not found.');
    const environment = Object.fromEntries(config.environmentKeys.map((key) => [key, this.secrets[this.mcpSecretKey(serverId, 'env', key)] || '']));
    const headers = Object.fromEntries(config.headerKeys.map((key) => [key, this.secrets[this.mcpSecretKey(serverId, 'header', key)] || '']));
    return { config: { ...config, args: [...config.args], environmentKeys: [...config.environmentKeys], headerKeys: [...config.headerKeys], disabledTools: [...config.disabledTools] }, environment, headers };
  }

  saveMcpServer(input: McpServerSaveInput) {
    const index = this.state.mcpServers.findIndex((server) => server.id === input.id);
    const existing = index >= 0 ? this.state.mcpServers[index] : undefined;
    const mergeSecrets = (kind: 'env' | 'header', existingKeys: string[], incoming: Record<string, string> | undefined) => {
      const values: Record<string, string> = {};
      if (!input.clearSecrets && existing) {
        for (const key of existingKeys) {
          const value = this.secrets[this.mcpSecretKey(input.id, kind, key)];
          if (value) values[key] = value;
        }
      }
      for (const [key, value] of Object.entries(incoming || {})) {
        if (value !== '') values[key] = value;
      }
      return values;
    };
    const environment = mergeSecrets('env', existing?.environmentKeys || [], input.environment);
    const headers = mergeSecrets('header', existing?.headerKeys || [], input.headers);
    if ((Object.values(environment).some(Boolean) || Object.values(headers).some(Boolean)) && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure secret storage is unavailable. Use the installed desktop app on Windows to save MCP environment values or headers.');
    }

    for (const key of existing?.environmentKeys || []) {
      const secretId = this.mcpSecretKey(input.id, 'env', key);
      delete this.secrets[secretId];
      delete this.state.encryptedSecrets[secretId];
    }
    for (const key of existing?.headerKeys || []) {
      const secretId = this.mcpSecretKey(input.id, 'header', key);
      delete this.secrets[secretId];
      delete this.state.encryptedSecrets[secretId];
    }
    const persistSecrets = (kind: 'env' | 'header', values: Record<string, string>) => {
      for (const [key, value] of Object.entries(values)) {
        if (!value) continue;
        const secretId = this.mcpSecretKey(input.id, kind, key);
        this.secrets[secretId] = value;
        this.state.encryptedSecrets[secretId] = safeStorage.encryptString(value).toString('base64');
      }
    };
    persistSecrets('env', environment);
    persistSecrets('header', headers);

    const clean: McpServerConfig = {
      id: input.id,
      name: input.name.trim(),
      transport: input.transport,
      command: input.command?.trim() || undefined,
      args: [...(input.args || [])],
      cwd: input.cwd?.trim() || undefined,
      url: input.url?.trim() || undefined,
      enabled: input.enabled ?? existing?.enabled ?? false,
      environmentKeys: Object.keys(environment),
      headerKeys: Object.keys(headers),
      disabledTools: [...(existing?.disabledTools || [])],
    };
    if (index >= 0) this.state.mcpServers[index] = clean;
    else this.state.mcpServers.push(clean);
    this.persist();
  }

  removeMcpServer(serverId: string) {
    const existing = this.getMcpServer(serverId);
    if (!existing) return;
    for (const key of [...existing.environmentKeys.map((key) => this.mcpSecretKey(serverId, 'env', key)), ...existing.headerKeys.map((key) => this.mcpSecretKey(serverId, 'header', key))]) {
      delete this.secrets[key];
      delete this.state.encryptedSecrets[key];
    }
    this.state.mcpServers = this.state.mcpServers.filter((server) => server.id !== serverId);
    this.persist();
  }

  setMcpServerEnabled(serverId: string, enabled: boolean) {
    const server = this.getMcpServer(serverId);
    if (!server) throw new Error('MCP server not found.');
    server.enabled = Boolean(enabled);
    this.persist();
  }

  setMcpToolEnabled(serverId: string, toolName: string, enabled: boolean) {
    const server = this.getMcpServer(serverId);
    if (!server) throw new Error('MCP server not found.');
    const disabled = new Set(server.disabledTools);
    if (enabled) disabled.delete(toolName);
    else disabled.add(toolName);
    server.disabledTools = [...disabled].slice(0, 300);
    this.persist();
  }

  setHfToken(token: string) {
    if (!safeStorage.isEncryptionAvailable() && token.trim()) throw new Error('Secure key storage is unavailable. Use the installed desktop app on Windows to save a Hugging Face token.');
    this.hfToken = token.trim();
    this.state.encryptedHfToken = token.trim() ? safeStorage.encryptString(token.trim()).toString('base64') : undefined;
    this.persist();
  }
}
