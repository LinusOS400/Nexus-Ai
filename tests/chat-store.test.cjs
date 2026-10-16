const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

let ChatSessionStore;
let tempDir;
let filePath;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-store-test-'));
  filePath = path.join(tempDir, 'chat-sessions.json');
  const outfile = path.join(tempDir, 'chat-store.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../electron/chat-store.ts')], bundle: true, platform: 'node', format: 'cjs', outfile });
  ChatSessionStore = require(outfile).ChatSessionStore;
});

after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

function sampleSession() {
  return {
    id: 'session-12345678', title: 'First title', createdAt: 100, updatedAt: 200, providerId: 'openrouter', modelId: 'test/model',
    messages: [
      { id: 'user-12345678', role: 'user', content: 'Please inspect this project', createdAt: 100 },
      { id: 'assistant-12345678', role: 'assistant', content: 'Done.', reasoning: 'Inspecting.', toolTraces: [{ id: 'trace-1', name: 'default_read', arguments: { path: 'src' }, state: 'complete', result: 'Files found' }], createdAt: 200 },
    ],
  };
}


test('chat sessions persist across store instances and retain message traces', () => {
  const first = new ChatSessionStore(filePath);
  const summaries = first.save(sampleSession());
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].title, 'Please inspect this project');
  assert.equal(summaries[0].messageCount, 2);

  const reopened = new ChatSessionStore(filePath);
  const session = reopened.get('session-12345678');
  assert.equal(session.messages[1].reasoning, 'Inspecting.');
  assert.equal(session.messages[1].toolTraces[0].result, 'Files found');
});


test('users can delete an individual message, a session, or all sessions', () => {
  const store = new ChatSessionStore(filePath);
  store.save(sampleSession());
  const deletion = store.deleteMessage('session-12345678', 'assistant-12345678');
  assert.equal(deletion.session.messages.length, 1);
  assert.equal(deletion.session.messages[0].id, 'user-12345678');
  assert.equal(deletion.sessions[0].messageCount, 1);

  const afterDelete = new ChatSessionStore(filePath);
  assert.equal(afterDelete.get('session-12345678').messages.length, 1);
  assert.deepEqual(afterDelete.delete('session-12345678'), []);
  assert.equal(afterDelete.get('session-12345678'), null);

  afterDelete.save(sampleSession());
  assert.deepEqual(afterDelete.clear(), []);
  assert.deepEqual(new ChatSessionStore(filePath).list(), []);
});


test('session payloads are validated and message text is bounded', () => {
  const store = new ChatSessionStore(filePath);
  assert.throws(() => store.save({ ...sampleSession(), id: '../unsafe' }), /Invalid chat session/);
  const oversized = sampleSession();
  oversized.messages[0].content = 'x'.repeat(130_000);
  store.save(oversized);
  assert.equal(store.get('session-12345678').messages[0].content.length, 120_000);
});
