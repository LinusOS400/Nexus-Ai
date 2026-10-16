import { contextBridge, ipcRenderer } from 'electron';
import type { NexusBridge, ChatRequest, AppSettings, McpServerInfo, McpServerSaveInput, ToolApprovalChoice, UpdateStatus } from '../shared/types';

const bridge: NexusBridge = {
  previewMode: false,
  getState: () => ipcRenderer.invoke('app:get-state'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('app:save-settings', settings),
  saveProvider: (provider) => ipcRenderer.invoke('provider:save', provider),
  removeProvider: (providerId) => ipcRenderer.invoke('provider:remove', providerId),
  refreshModels: (providerId) => ipcRenderer.invoke('provider:refresh-models', providerId),
  refreshAllModels: () => ipcRenderer.invoke('provider:refresh-all'),
  getProviderCatalog: (forceRefresh) => ipcRenderer.invoke('provider:catalog', forceRefresh),
  addCatalogProvider: (providerId) => ipcRenderer.invoke('provider:add-catalog', providerId),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  getChatSessions: () => ipcRenderer.invoke('chat-sessions:list'),
  getChatSession: (sessionId) => ipcRenderer.invoke('chat-sessions:get', sessionId),
  saveChatSession: (session) => ipcRenderer.invoke('chat-sessions:save', session),
  deleteChatSession: (sessionId) => ipcRenderer.invoke('chat-sessions:delete', sessionId),
  deleteChatMessage: (sessionId, messageId) => ipcRenderer.invoke('chat-sessions:delete-message', sessionId, messageId),
  clearChatSessions: () => ipcRenderer.invoke('chat-sessions:clear'),
  saveMcpServer: (input: McpServerSaveInput) => ipcRenderer.invoke('mcp:save', input),
  removeMcpServer: (serverId) => ipcRenderer.invoke('mcp:remove', serverId),
  connectMcpServer: (serverId) => ipcRenderer.invoke('mcp:connect', serverId),
  disconnectMcpServer: (serverId) => ipcRenderer.invoke('mcp:disconnect', serverId),
  refreshMcpServer: (serverId) => ipcRenderer.invoke('mcp:refresh', serverId),
  setMcpServerEnabled: (serverId, enabled) => ipcRenderer.invoke('mcp:set-enabled', serverId, enabled),
  setMcpToolEnabled: (serverId, toolKey, enabled) => ipcRenderer.invoke('mcp:tool-enabled', serverId, toolKey, enabled),
  onMcpServers: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, servers: McpServerInfo[]) => callback(servers);
    ipcRenderer.on('mcp:servers', listener);
    return () => ipcRenderer.removeListener('mcp:servers', listener);
  },
  clearSessionPermissions: () => ipcRenderer.invoke('permissions:clear-session'),
  setHuggingFaceToken: (token) => ipcRenderer.invoke('hf:set-token', token),
  searchHuggingFace: (query) => ipcRenderer.invoke('hf:search', query),
  getHuggingFaceFiles: (repoId) => ipcRenderer.invoke('hf:files', repoId),
  downloadHuggingFaceFile: (repoId, filename) => ipcRenderer.invoke('hf:download', repoId, filename),
  openProject: () => ipcRenderer.invoke('project:open'),
  listProjectFiles: () => ipcRenderer.invoke('project:list'),
  readProjectFile: (relativePath) => ipcRenderer.invoke('project:read', relativePath),
  writeProjectFile: (relativePath, content) => ipcRenderer.invoke('project:write', relativePath, content),
  getProjectPreviewUrl: (relativePath) => ipcRenderer.invoke('project:preview-url', relativePath),
  updateProjectPreview: (relativePath, content) => ipcRenderer.invoke('project:preview-update', relativePath, content),
  runShellCommand: (command) => ipcRenderer.invoke('shell:run', command),
  setRuntimePath: () => ipcRenderer.invoke('dialog:runtime-path'),
  setLocalModelPath: () => ipcRenderer.invoke('dialog:model-path'),
  selectLocalModel: (modelPath) => ipcRenderer.invoke('runtime:select-model', modelPath),
  startLocalRuntime: () => ipcRenderer.invoke('runtime:start'),
  stopLocalRuntime: () => ipcRenderer.invoke('runtime:stop'),
  getLocalModels: () => ipcRenderer.invoke('models:local'),
  startChat: async (request: ChatRequest, suppliedRequestId?: string) => {
    const requestId = suppliedRequestId || globalThis.crypto.randomUUID();
    ipcRenderer.send('chat:start', { requestId, request });
    return requestId;
  },
  onChatEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<Parameters<NexusBridge['onChatEvent']>[0]>[0]) => callback(payload);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  cancelChat: (requestId) => ipcRenderer.send('chat:cancel', requestId),
  respondToTool: (toolId, decision: ToolApprovalChoice) => ipcRenderer.invoke('tool:approval', toolId, decision),
  answerQuestion: (questionId, answer) => ipcRenderer.invoke('tool:question-answer', questionId, answer),
  onDownloadProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { filename: string; received: number; total?: number; percent?: number }) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  onRuntimeLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('runtime:log', listener);
    return () => ipcRenderer.removeListener('runtime:log', listener);
  },
  onRuntimeStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: import('../shared/types').RuntimeStatus) => callback(status);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
};

contextBridge.exposeInMainWorld('nexus', bridge);
