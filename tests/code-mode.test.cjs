const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

let codeMode;
let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-code-mode-test-'));
  const outfile = path.join(tempDir, 'code-mode.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../electron/code-mode.ts')], bundle: true, platform: 'node', format: 'cjs', outfile });
  codeMode = require(outfile);
});

after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

function mcpTool(serverId, capabilityName, capabilityKind = 'tool') {
  return { name: `mcp_${serverId}_${capabilityName}`, description: `[MCP ${serverId}]\nTest capability ${capabilityName}`, parameters: { type: 'object', properties: {} }, serverId, serverName: serverId, capabilityKey: capabilityName, capabilityKind, capabilityName, approvalKey: `mcp:${serverId}:${capabilityName}` };
}


test('restricted Code Mode awaits namespaced MCP tools and captures results', async () => {
  const tool = mcpTool('playwright', 'browser_snapshot');
  const invoked = [];
  const result = await codeMode.executeCodeMode(
    'const snapshot = await tools.playwright.browser_snapshot({});\nconsole.log(snapshot);',
    [tool],
    async (target, args) => { invoked.push({ name: target.capabilityName, args }); return 'button "Continue"'; },
  );
  assert.deepEqual(invoked, [{ name: 'browser_snapshot', args: Object.create(null) }]);
  assert.match(result, /tools\.playwright\.browser_snapshot:\nbutton "Continue"/);
  assert.match(result, /button "Continue"/);
});


test('restricted Code Mode supports bracket notation for punctuated MCP method names', async () => {
  const tool = mcpTool('context7', 'query-docs');
  const invoked = [];
  const result = await codeMode.executeCodeMode(
    'const docs = await tools.context7["query-docs"]({ libraryId: "/react", query: "hooks" });\nconsole.log(JSON.stringify(docs));',
    [tool],
    async (_target, args) => { invoked.push(args); return 'useState docs'; },
  );
  assert.deepEqual(invoked[0], Object.assign(Object.create(null), { libraryId: '/react', query: 'hooks' }));
  assert.match(result, /useState docs/);
});


test('Code Mode rejects arbitrary JavaScript and unconnected namespace calls', async () => {
  await assert.rejects(() => codeMode.executeCodeMode('process.exit(0);', [mcpTool('playwright', 'browser_snapshot')], async () => ''), /Only awaited MCP calls/);
  await assert.rejects(() => codeMode.executeCodeMode('await tools.playwright.browser_click({});', [], async () => ''), /No MCP namespaces are connected/);
  await assert.rejects(() => codeMode.executeCodeMode('while (true) {}', [mcpTool('playwright', 'browser_snapshot')], async () => ''), /does not allow WhileStatement/);
});


test('Code Mode caps tool calls and rejects prototype-sensitive paths', async () => {
  const tool = mcpTool('browser', 'snapshot');
  const code = Array.from({ length: 21 }, () => 'await tools.browser.snapshot({});').join('\n');
  let calls = 0;
  await assert.rejects(() => codeMode.executeCodeMode(code, [tool], async () => { calls += 1; return 'ok'; }), /at most 20 MCP calls/);
  assert.equal(calls, 20);
  await assert.rejects(() => codeMode.executeCodeMode('await tools.browser["__proto__"]({});', [tool], async () => ''), /Invalid namespaced tool path/);
});


test('provider Code Mode description lists only connected methods', () => {
  const tool = mcpTool('context7', 'query-docs');
  const description = codeMode.buildCodeModeDescription([tool]);
  assert.match(description, /tools\.context7/);
  assert.match(description, /query-docs/);
  assert.match(description, /no shell, filesystem, imports/);
});
