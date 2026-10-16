const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

let ai;
let tempDir;
const originalFetch = globalThis.fetch;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ai-test-'));
  const outfile = path.join(tempDir, 'ai.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../electron/ai.ts')], bundle: true, platform: 'node', format: 'cjs', outfile });
  ai = require(outfile);
});

after(() => {
  globalThis.fetch = originalFetch;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const tool = { name: 'default_read', description: 'Read test files', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const request = { providerId: 'test', model: 'test-model', messages: [{ role: 'user', content: 'Inspect the project.' }], systemPrompt: '', enableTools: true, contextTokens: 8192, maxOutputTokens: 1024, temperature: 0.2 };
function provider(kind, baseUrl = 'https://provider.example/v1') { return { id: 'test', name: 'Test', kind, baseUrl, hasKey: true, status: 'active', models: [] }; }
function response(body, contentType = 'text/event-stream') { return new Response(body, { status: 200, headers: { 'content-type': contentType } }); }
function sse(...packets) { return packets.map((packet) => `data: ${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n\n`).join(''); }


test('OpenAI-compatible streaming preserves reasoning, executes tool calls, and resumes', async () => {
  const originalBodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    originalBodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) return response(sse(
      { choices: [{ delta: { reasoning_content: 'I should inspect the files. ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'default_read', arguments: '{"path":"src"}' } }] } }] },
      '[DONE]',
    ));
    return response(sse({ choices: [{ delta: { content: 'The project uses src.' } }] }, '[DONE]'));
  };
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  const statuses = [];
  await ai.streamProviderChat(provider('openai-compatible'), 'secret', request, new AbortController().signal,
    (chunk) => text.push(chunk), (chunk) => reasoning.push(chunk), (status) => statuses.push(status),
    async (name, args) => { toolCalls.push({ name, args }); return 'src contains the app.'; }, [tool]);

  assert.equal(text.join(''), 'The project uses src.');
  assert.equal(reasoning.join(''), 'I should inspect the files. ');
  assert.deepEqual(toolCalls, [{ name: 'default_read', args: { path: 'src' } }]);
  assert.equal(originalBodies.length, 2);
  assert.equal(originalBodies[1].messages.at(-2).reasoning_content, 'I should inspect the files. ');
  assert.equal(originalBodies[1].messages.at(-1).content, 'src contains the app.');
  assert.ok(statuses.includes('Calling tool · default_read'));
});


test('OpenAI-compatible JSON responses are parsed when a provider ignores stream=true', async () => {
  globalThis.fetch = async () => response(JSON.stringify({ choices: [{ message: { content: 'Non-stream fallback works.' } }] }), 'application/json');
  const text = [];
  await ai.streamProviderChat(provider('openai-compatible'), '', { ...request, enableTools: false }, new AbortController().signal,
    (chunk) => text.push(chunk), () => {}, () => {}, async () => '', []);
  assert.equal(text.join(''), 'Non-stream fallback works.');
});


test('Anthropic non-stream responses preserve signed thinking blocks across tool continuation', async () => {
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) return response(JSON.stringify({ type: 'message', content: [
      { type: 'thinking', thinking: 'Let me inspect.', signature: 'signed-thought' },
      { type: 'tool_use', id: 'tool-1', name: 'default_read', input: { path: 'src' } },
    ] }), 'application/json');
    return response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Inspection complete.' }] }), 'application/json');
  };
  const text = [];
  const reasoning = [];
  await ai.streamProviderChat(provider('anthropic', 'https://provider.example'), 'secret', request, new AbortController().signal,
    (chunk) => text.push(chunk), (chunk) => reasoning.push(chunk), () => {}, async () => 'There are three source files.', [tool]);

  assert.equal(text.join(''), 'Inspection complete.');
  assert.equal(reasoning.join(''), 'Let me inspect.');
  const assistantMessage = bodies[1].messages.find((message) => message.role === 'assistant');
  assert.equal(assistantMessage.content[0].signature, 'signed-thought');
  assert.equal(bodies[1].messages.at(-1).content[0].content, 'There are three source files.');
});


test('Gemini non-stream response retains thought parts and sends function results', async () => {
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) return response(JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'Check the project.', thought: true },
      { functionCall: { name: 'default_read', args: { path: 'src' } }, thoughtSignature: 'gemini-signed-thought' },
    ] } }] }), 'application/json');
    return response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini continuation works.' }] } }] }), 'application/json');
  };
  const text = [];
  const reasoning = [];
  await ai.streamProviderChat(provider('gemini', 'https://provider.example/v1beta'), 'secret', request, new AbortController().signal,
    (chunk) => text.push(chunk), (chunk) => reasoning.push(chunk), () => {}, async () => 'File list.', [tool]);

  assert.equal(text.join(''), 'Gemini continuation works.');
  assert.equal(reasoning.join(''), 'Check the project.');
  assert.equal(bodies[1].contents.at(-2).parts[0].thought, true);
  assert.equal(bodies[1].contents.at(-2).parts[1].thoughtSignature, 'gemini-signed-thought');
  assert.equal(bodies[1].contents.at(-1).parts[0].functionResponse.response.result, 'File list.');
});
