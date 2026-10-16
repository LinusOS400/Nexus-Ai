import type { ChatRequest, ProviderInfo, ToolDefinition, ToolRequest } from '../shared/types';

const API_VERSION = '2023-06-01';

type EmitText = (text: string) => void;
type EmitReasoning = (text: string) => void;
type EmitStatus = (text: string) => void;
type RunTool = (name: string, args: Record<string, unknown>) => Promise<string>;

const TOOL_DEFS: ToolDefinition[] = [
  { name: 'default_read', description: 'Read a UTF-8 text file or list a directory inside the open project. Paths must be project-relative; binary files are not returned as text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Project-relative file or directory path.' }, offset: { type: 'integer', description: 'Optional one-based line number to start from.' }, limit: { type: 'integer', description: 'Optional maximum number of lines.' } }, required: ['path'], additionalProperties: false } },
  { name: 'default_write', description: 'Create or replace a UTF-8 file inside the open project. The user must approve the complete change.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Project-relative destination path.' }, content: { type: 'string', description: 'Complete new file contents.' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'default_edit', description: 'Replace exact text in a project file. The user must approve the change. Read the file first and provide a unique old_text unless replace_all is intentional.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } },
  { name: 'default_glob', description: 'Find project paths using a glob such as **/*.ts, src/**, or *.json. Hidden dependency/build folders are excluded.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional project-relative directory scope.' } }, required: ['pattern'], additionalProperties: false } },
  { name: 'default_grep', description: 'Search project text files for a literal phrase. Results include file paths and line numbers.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Optional project-relative directory scope.' }, include: { type: 'string', description: 'Optional glob filter such as **/*.tsx.' } }, required: ['query'], additionalProperties: false } },
  { name: 'default_shell', description: 'Run a command in the project folder. On Windows this uses PowerShell; on other systems it uses the configured shell. If no project is open, explicitly enable shell access in Tools & safety. On Windows, list mounted drives with Get-PSDrive -PSProvider FileSystem. Shell commands require user approval unless explicitly allowed.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } },
  { name: 'default_webfetch', description: 'Fetch a public HTTP(S) webpage and return readable text. Private/local network addresses and redirects to them are blocked.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'default_websearch', description: 'Search the public web and return a short list of result titles, URLs, and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer', description: 'Maximum number of results, 1–10.' } }, required: ['query'], additionalProperties: false } },
  { name: 'default_question', description: 'Ask the user a question and wait for their answer. Provide up to six concise options when a choice is helpful.', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } } }, required: ['question'], additionalProperties: false } },
  { name: 'default_skill', description: 'Load specialized instructions. Built-in skills: debugging, code-review, testing, refactor, research. Project custom skills can be stored as .nexus/skills/<name>/SKILL.md.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name or "list".' } }, required: ['name'], additionalProperties: false } },
  { name: 'default_subagent', description: 'Delegate a focused task to a separate child-model call using the currently selected provider/model. The child has no tools or filesystem access.', parameters: { type: 'object', properties: { task: { type: 'string' }, role: { type: 'string', enum: ['general', 'explore', 'media', 'research'] } }, required: ['task'], additionalProperties: false } },
  { name: 'default_execute', description: 'Run restricted Code Mode: make one or more sequential `await tools.<namespace>.<tool>({...JSON args...})` calls to connected MCP servers. Use bracket notation for tool names containing punctuation. This is an orchestrator, not arbitrary JavaScript; every called MCP capability is separately approval-gated.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Sequence of tool calls, each on its own line. Example: const tabs = await tools.playwright.browser_tabs({});' } }, required: ['code'], additionalProperties: false } },
];

export const TOOL_NAMES = new Set<string>(TOOL_DEFS.map((tool) => tool.name));

export function getBuiltinToolDefinitions(projectOpen: boolean, shellAllowed: boolean, executeDescription?: string): ToolDefinition[] {
  const projectTools = new Set(['default_read', 'default_write', 'default_edit', 'default_glob', 'default_grep']);
  return TOOL_DEFS.filter((tool) => tool.name === 'default_shell' ? shellAllowed : (projectOpen || !projectTools.has(tool.name)))
    .map((tool) => tool.name === 'default_execute' && executeDescription ? { ...tool, description: executeDescription } : tool);
}

function openAiTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}
function anthropicTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}
function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'type' && typeof item === 'string') result[key] = item.toUpperCase();
    else result[key] = toGeminiSchema(item);
  }
  return result;
}
function geminiTools(tools: ToolDefinition[]) {
  return [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.parameters) })) }];
}

function endpoint(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function errorFromResponse(status: number, body: string) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || body;
  } catch { /* Keep provider response as-is. */ }
  return new Error(`Provider returned ${status}: ${message.slice(0, 700) || 'Unknown error'}`);
}

async function* readSse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.ok) throw errorFromResponse(response.status, await response.text());
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('text/event-stream')) {
    const body = await response.text();
    if (!body.trim()) throw new Error('Provider returned an empty response.');
    yield body;
    return;
  }
  if (!response.body) throw new Error('Provider returned an empty response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    const data = buffer.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') yield data;
    else if (buffer.trim().startsWith('{') || buffer.trim().startsWith('[')) yield buffer.trim();
  } finally {
    try { reader.releaseLock(); } catch { /* no-op */ }
  }
}

function parseJson(raw: string) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`The model returned malformed tool arguments: ${raw.slice(0, 300)}`); }
}

function extractOpenAiReasoning(delta: Record<string, unknown> | undefined) {
  if (!delta) return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'analysis']) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
  }
  const details = delta.reasoning_details;
  if (Array.isArray(details)) return details.map((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : '').filter(Boolean).join('');
  return '';
}

function toolEvent(id: string, name: string, args: Record<string, unknown>): ToolRequest {
  const def = TOOL_DEFS.find((item) => item.name === name);
  return {
    id,
    name,
    arguments: args,
    description: def?.description || 'The model requested an application tool.',
    requiresApproval: true,
  };
}

async function runOpenAiCompatible(provider: ProviderInfo, apiKey: string, request: ChatRequest, signal: AbortSignal, emit: EmitText, emitReasoning: EmitReasoning, status: EmitStatus, runTool: RunTool, availableTools: ToolDefinition[]) {
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const messages: Array<Record<string, unknown>> = [];
  if (request.systemPrompt.trim()) messages.push({ role: 'system', content: request.systemPrompt });
  messages.push(...request.messages.map(({ role, content }) => ({ role, content })));

  for (let round = 0; round < 5; round++) {
    status(round === 0 ? 'Generating response' : 'Continuing with tool results');
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
    };
    if (request.enableTools && availableTools.length) {
      body.tools = openAiTools(availableTools);
      body.tool_choice = 'auto';
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint(provider.baseUrl, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal });
    let assistantText = '';
    let assistantReasoning = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const raw of readSse(response, signal)) {
      const packet = parseJson(raw);
      if (packet.error) throw new Error(packet.error.message || 'Provider stream error.');
      const choice = packet.choices?.[0];
      const delta = choice?.delta || choice?.message;
      const reasoning = extractOpenAiReasoning(delta);
      if (reasoning) { assistantReasoning += reasoning; emitReasoning(reasoning); }
      if (typeof delta?.content === 'string') {
        assistantText += delta.content;
        emit(delta.content);
      } else if (Array.isArray(delta?.content)) {
        const text = delta.content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('');
        if (text) { assistantText += text; emit(text); }
      }
      const streamedCalls = delta?.tool_calls || (delta?.function_call ? [{ index: 0, id: 'legacy-function-call', function: delta.function_call }] : []);
      for (const part of streamedCalls) {
        const index = Number(part.index || 0);
        const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
        if (part.id) current.id += part.id;
        if (part.function?.name) current.name += String(part.function.name);
        if (typeof part.function?.arguments === 'string') current.arguments += part.function.arguments;
        else if (part.function?.arguments && typeof part.function.arguments === 'object') current.arguments = JSON.stringify(part.function.arguments);
        toolCalls.set(index, current);
      }
    }
    if (!toolCalls.size) return;
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([index, call]) => ({
      index, id: call.id || `tool-${round}-${index}`, name: call.name, arguments: parseJson(call.arguments || '{}'),
    }));
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
      tool_calls: calls.map(({ id, name, arguments: args }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
    });
    for (const call of calls) {
      if (!availableToolNames.has(call.name)) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Tool not available: ${call.name}` });
        continue;
      }
      status(`Calling tool · ${call.name}`);
      const result = await runTool(call.name, call.arguments);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  emit('\n\nI reached the tool-call limit for this turn.');
}

async function runAnthropic(provider: ProviderInfo, apiKey: string, request: ChatRequest, signal: AbortSignal, emit: EmitText, emitReasoning: EmitReasoning, status: EmitStatus, runTool: RunTool, availableTools: ToolDefinition[]) {
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const messages: Array<Record<string, unknown>> = request.messages.map(({ role, content }) => ({ role, content }));
  for (let round = 0; round < 5; round++) {
    status(round === 0 ? 'Generating response' : 'Continuing with tool results');
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      messages,
      stream: true,
    };
    if (request.systemPrompt.trim()) body.system = request.systemPrompt;
    if (request.enableTools && availableTools.length) body.tools = anthropicTools(availableTools);
    const response = await fetch(endpoint(provider.baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION, accept: 'text/event-stream' },
      body: JSON.stringify(body), signal,
    });
    const blocks: Array<any> = [];
    for await (const raw of readSse(response, signal)) {
      const packet = parseJson(raw);
      if (packet.type === 'error') throw new Error(packet.error?.message || 'Anthropic stream error.');
      if (packet.type === 'message' && Array.isArray(packet.content)) {
        packet.content.forEach((block: any, index: number) => {
          if (block.type === 'tool_use') blocks[index] = { type: 'tool_use', id: block.id, name: block.name, inputJson: JSON.stringify(block.input || {}) };
          else if (block.type === 'thinking') { blocks[index] = { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' }; if (block.thinking) emitReasoning(block.thinking); }
          else if (block.type === 'redacted_thinking') blocks[index] = { type: 'redacted_thinking', data: block.data || '' };
          else { blocks[index] = { type: 'text', text: block.text || '' }; if (block.text) emit(block.text); }
        });
      } else if (packet.type === 'content_block_start') {
        const block = packet.content_block || {};
        if (block.type === 'tool_use') blocks[packet.index] = { type: 'tool_use', id: block.id, name: block.name, inputJson: '' };
        else if (block.type === 'thinking') {
          blocks[packet.index] = { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' };
          if (block.thinking) emitReasoning(block.thinking);
        } else if (block.type === 'redacted_thinking') blocks[packet.index] = { type: 'redacted_thinking', data: block.data || '' };
        else blocks[packet.index] = { type: 'text', text: block.text || '' };
      } else if (packet.type === 'content_block_delta') {
        const block = blocks[packet.index];
        if (packet.delta?.type === 'text_delta') {
          const text = packet.delta.text || '';
          if (block) block.text = (block.text || '') + text;
          emit(text);
        } else if (packet.delta?.type === 'thinking_delta' && block) {
          const thought = packet.delta.thinking || '';
          block.thinking = (block.thinking || '') + thought;
          if (thought) emitReasoning(thought);
        } else if (packet.delta?.type === 'signature_delta' && block) block.signature = (block.signature || '') + (packet.delta.signature || '');
        else if (packet.delta?.type === 'input_json_delta' && block) block.inputJson += packet.delta.partial_json || '';
      }
    }
    const toolBlocks = blocks.filter((block) => block?.type === 'tool_use');
    if (!toolBlocks.length) return;
    const assistantContent = blocks.filter(Boolean).map((block) => {
      if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.inputJson ? parseJson(block.inputJson) : {} };
      if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' };
      if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data || '' };
      return { type: 'text', text: block.text || '' };
    });
    messages.push({ role: 'assistant', content: assistantContent });
    const results: Array<Record<string, unknown>> = [];
    for (const block of toolBlocks) {
      status(`Calling tool · ${block.name}`);
      const args = block.inputJson ? parseJson(block.inputJson) : {};
      const result = availableToolNames.has(block.name) ? await runTool(block.name, args) : `Tool not available: ${block.name}`;
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }
  emit('\n\nI reached the tool-call limit for this turn.');
}

async function runGemini(provider: ProviderInfo, apiKey: string, request: ChatRequest, signal: AbortSignal, emit: EmitText, emitReasoning: EmitReasoning, status: EmitStatus, runTool: RunTool, availableTools: ToolDefinition[]) {
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const contents: Array<Record<string, unknown>> = request.messages.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }));
  for (let round = 0; round < 5; round++) {
    status(round === 0 ? 'Generating response' : 'Continuing with tool results');
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: request.maxOutputTokens, temperature: request.temperature },
    };
    if (request.systemPrompt.trim()) body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    if (request.enableTools && availableTools.length) body.tools = geminiTools(availableTools);
    const url = `${endpoint(provider.baseUrl, `/models/${encodeURIComponent(request.model)}:streamGenerateContent`)}?alt=sse`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, accept: 'text/event-stream' },
      body: JSON.stringify(body), signal,
    });
    let text = '';
    const thoughtParts: Array<Record<string, unknown>> = [];
    const calls: Array<{ name: string; args: Record<string, unknown>; modelPart: Record<string, unknown> }> = [];
    for await (const raw of readSse(response, signal)) {
      const packet = parseJson(raw);
      const parts = packet.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (typeof part.text === 'string') {
          if (part.thought === true || part.thinking === true) { thoughtParts.push({ text: part.text, thought: true }); emitReasoning(part.text); }
          else { text += part.text; emit(part.text); }
        }
        if (typeof part.thoughtSummary === 'string') emitReasoning(part.thoughtSummary);
        if (part.functionCall?.name) calls.push({ name: part.functionCall.name, args: part.functionCall.args || {}, modelPart: { functionCall: part.functionCall, ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}) } });
      }
    }
    if (!calls.length) return;
    const functionParts = calls.map((call) => call.modelPart);
    contents.push({ role: 'model', parts: [...thoughtParts, ...(text ? [{ text }] : []), ...functionParts] });
    const responseParts: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      status(`Calling tool · ${call.name}`);
      const result = availableToolNames.has(call.name) ? await runTool(call.name, call.args) : `Tool not available: ${call.name}`;
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  emit('\n\nI reached the tool-call limit for this turn.');
}

export async function streamProviderChat(
  provider: ProviderInfo,
  apiKey: string,
  request: ChatRequest,
  signal: AbortSignal,
  emit: EmitText,
  emitReasoning: EmitReasoning,
  status: EmitStatus,
  runTool: RunTool,
  availableTools: ToolDefinition[],
) {
  if (provider.kind === 'anthropic') return runAnthropic(provider, apiKey, request, signal, emit, emitReasoning, status, runTool, availableTools);
  if (provider.kind === 'gemini') return runGemini(provider, apiKey, request, signal, emit, emitReasoning, status, runTool, availableTools);
  return runOpenAiCompatible(provider, apiKey, request, signal, emit, emitReasoning, status, runTool, availableTools);
}

export function createToolRequest(name: string, args: Record<string, unknown>, description?: string, label?: string): ToolRequest {
  const id = `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let displayArgs = args;
  try {
    const serialized = JSON.stringify(args);
    if (serialized.length > 16_000) displayArgs = { preview: `${serialized.slice(0, 15_500)}…`, truncated: true };
    else displayArgs = JSON.parse(serialized || '{}') as Record<string, unknown>;
  } catch { displayArgs = { preview: '[Arguments could not be displayed safely]' }; }
  return { ...toolEvent(id, name, displayArgs), ...(description ? { description } : {}), ...(label ? { label } : {}) };
}
