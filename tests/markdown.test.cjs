const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

let markdown;
let syntax;
let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-markdown-test-'));
  const markdownOut = path.join(tempDir, 'markdown.cjs');
  const syntaxOut = path.join(tempDir, 'syntax.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../src/markdown.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: markdownOut });
  buildSync({ entryPoints: [path.join(__dirname, '../src/syntax-highlight.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: syntaxOut });
  markdown = require(markdownOut);
  syntax = require(syntaxOut);
});

after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

test('HTML fences render as a code part without exposing the fence markers', () => {
  const result = markdown.parseMarkdownParts('Here is the page:\n```html\n<!doctype html>\n<html><body>Hello</body></html>\n```\nDone.');
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { type: 'text', text: 'Here is the page:\n' });
  assert.deepEqual(result[1], { type: 'code', language: 'html', code: '<!doctype html>\n<html><body>Hello</body></html>' });
  assert.deepEqual(result[2], { type: 'text', text: 'Done.' });
});

test('tilde fences accept brace language metadata and preserve a requested filename', () => {
  const result = markdown.parseMarkdownParts('~~~~{.tsx filename="src/App.tsx"}\nexport default () => <main />;\n~~~~');
  assert.deepEqual(result, [{ type: 'code', language: 'tsx', filename: 'App.tsx', code: 'export default () => <main />;' }]);
});

test('unclosed fences remain readable and unsupported filenames fall back safely', () => {
  const result = markdown.parseMarkdownParts('```python\nprint("hello")\n');
  assert.deepEqual(result, [{ type: 'code', language: 'python', code: 'print("hello")' }]);
  assert.equal(markdown.codeFileName('python'), 'snippet.py');
  assert.equal(markdown.codeFileName('html', 'index.html'), 'index.html');
  assert.equal(markdown.codeFileName('unknown'), 'snippet.txt');
  assert.equal(markdown.codeFileName('dockerfile'), 'Dockerfile');
});

test('syntax highlighter adds language colors and safely escapes source HTML', () => {
  const javascript = syntax.highlightSource('const total = 42;', 'javascript');
  assert.match(javascript, /hljs-keyword/);
  assert.match(javascript, /hljs-number/);

  const c = syntax.highlightSource('#include <stdio.h>\\nint main(void) { return 0; }', 'c');
  assert.match(c, /hljs-keyword/);
  assert.match(c, /hljs-meta/);

  const html = syntax.highlightSource('<script>alert("safe")</script>', 'html');
  assert.match(html, /hljs-tag/);
  assert.match(html, /&lt;/);
  assert.match(html, /hljs-name/);
  assert.doesNotMatch(html, /<script>/);
});
