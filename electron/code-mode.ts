import { parse as parseJavaScript } from 'acorn';
import type { McpAgentTool } from './mcp';

function codeModeMethodName(tool: McpAgentTool) {
  return tool.capabilityKind === 'tool' ? tool.capabilityName : `${tool.capabilityKind}_${tool.capabilityName}`;
}

function codeMember(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

export function buildCodeModeDescription(tools: McpAgentTool[]) {
  const base = 'Run a restricted Code Mode sequence that composes connected MCP calls. Supported statements are `const x = await tools.<namespace>.<tool>({...JSON args...});`, `await tools.<namespace>["tool-name"]({...});`, and `console.log(x)`. Only these tool calls and simple literals/objects/arrays are interpreted—no shell, filesystem, imports, loops, or arbitrary JavaScript. Every MCP call still gets its own approval. ';
  if (!tools.length) return `${base}No MCP servers are connected yet; add and connect a server in Settings → Tools & safety → MCP servers.`;
  const groups = new Map<string, McpAgentTool[]>();
  for (const tool of tools) groups.set(tool.serverId, [...(groups.get(tool.serverId) || []), tool]);
  const lines = ['Connected namespaces and callable methods:'];
  for (const [namespace, items] of groups) {
    lines.push(`tools${codeMember(namespace)} (${items[0]?.serverName || namespace}):`);
    for (const tool of items.slice(0, 80)) lines.push(`  - ${codeMember(codeModeMethodName(tool))} — ${tool.description.split('\n').slice(1, 2).join('').slice(0, 180)}`);
    if (items.length > 80) lines.push(`  … ${items.length - 80} more capabilities are available on this server.`);
  }
  return `${base}\n${lines.join('\n')}`.slice(0, 12_000);
}

export async function executeCodeMode(code: string, tools: McpAgentTool[], invoke: (tool: McpAgentTool, args: Record<string, unknown>) => Promise<string>) {
  if (typeof code !== 'string' || !code.trim() || code.length > 30_000) throw new Error('Provide Code Mode source under 30,000 characters.');
  if (!tools.length) throw new Error('No MCP namespaces are connected. Connect an MCP server first.');
  let program: any;
  try { program = parseJavaScript(code, { ecmaVersion: 'latest', sourceType: 'module' }) as any; }
  catch (error) { throw new Error(`Could not parse Code Mode source: ${error instanceof Error ? error.message : String(error)}`); }
  if (program.body.length > 40) throw new Error('Code Mode accepts at most 40 top-level statements.');
  const variables = new Map<string, unknown>();
  const outputs: string[] = [];
  let callCount = 0;

  const evaluate = (node: any): any => {
    if (!node) return undefined;
    if (node.type === 'Literal') {
      if (typeof node.value === 'function' || typeof node.value === 'bigint' || node.regex) throw new Error('Only JSON-compatible literals are allowed in Code Mode.');
      return node.value;
    }
    if (node.type === 'Identifier') {
      if (node.name === 'undefined') return undefined;
      if (!variables.has(node.name)) throw new Error(`Unknown Code Mode variable “${node.name}”.`);
      return variables.get(node.name);
    }
    if (node.type === 'ObjectExpression') {
      if (node.properties.length > 200) throw new Error('Code Mode objects may contain at most 200 properties.');
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.shorthand && property.computed) throw new Error('Only plain object properties are allowed in Code Mode.');
        const key = property.computed ? evaluate(property.key) : property.key.name ?? property.key.value;
        if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Object keys must be strings or numbers.');
        result[String(key)] = evaluate(property.value);
      }
      return result;
    }
    if (node.type === 'ArrayExpression') {
      if (node.elements.length > 500) throw new Error('Code Mode arrays may contain at most 500 items.');
      return node.elements.map((element: any) => evaluate(element));
    }
    if (node.type === 'TemplateLiteral') {
      let result = node.quasis[0]?.value?.cooked || '';
      node.expressions.forEach((expression: any, index: number) => { result += String(evaluate(expression) ?? '') + (node.quasis[index + 1]?.value?.cooked || ''); });
      return result;
    }
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = evaluate(node.left); const right = evaluate(node.right);
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      if ((typeof left === 'string' || typeof left === 'number') && (typeof right === 'string' || typeof right === 'number')) return `${left}${right}`;
    }
    if (node.type === 'MemberExpression') {
      if (node.object.type === 'Identifier' && node.object.name === 'JSON' && !node.computed && node.property.name === 'stringify') return { __safeBuiltin: 'json-stringify' };
      const object = evaluate(node.object);
      const key = node.computed ? evaluate(node.property) : node.property.name;
      if (!object || typeof object !== 'object' || typeof key !== 'string' && typeof key !== 'number') throw new Error('Code Mode can only read properties from returned JSON values.');
      const property = String(key);
      if (['__proto__', 'prototype', 'constructor'].includes(property) || !Object.hasOwn(object, property)) throw new Error(`Property “${property}” is not available in Code Mode.`);
      return (object as Record<string, unknown>)[property];
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const target = evaluate(node.callee);
      if (target?.__safeBuiltin === 'json-stringify' && node.arguments.length <= 1) return JSON.stringify(evaluate(node.arguments[0]));
    }
    throw new Error(`Code Mode does not support ${node.type} expressions. Use literals and MCP tool results.`);
  };

  const memberPath = (node: any) => {
    const segments: string[] = [];
    let current = node;
    while (current?.type === 'MemberExpression') {
      const segment = current.computed ? evaluate(current.property) : current.property.name;
      if (typeof segment !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(segment)) throw new Error('Invalid namespaced tool path.');
      segments.unshift(segment);
      current = current.object;
    }
    if (current?.type !== 'Identifier' || current.name !== 'tools') throw new Error('Calls must target a connected tools namespace, such as tools.playwright.browser_navigate(...).');
    return segments;
  };

  const runCall = async (call: any) => {
    if (call.type !== 'CallExpression' || call.optional || call.arguments.length > 1 || call.arguments.some((arg: any) => arg.type === 'SpreadElement')) throw new Error('MCP calls need a single plain argument object.');
    const segments = memberPath(call.callee);
    if (segments.length !== 2) throw new Error('MCP calls must use the form tools.<namespace>.<tool>(args).');
    const [namespace, method] = segments;
    const tool = tools.find((item) => item.serverId === namespace && codeModeMethodName(item) === method);
    if (!tool) throw new Error(`No connected MCP capability named tools${codeMember(namespace)}${codeMember(method)}.`);
    const args = call.arguments.length ? evaluate(call.arguments[0]) : Object.create(null);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP tool arguments must be a plain object.');
    const encoded = JSON.stringify(args);
    if (encoded.length > 100_000) throw new Error('MCP call arguments exceed the 100 KB safety limit.');
    callCount += 1;
    if (callCount > 20) throw new Error('Code Mode allows at most 20 MCP calls per execution.');
    const result = await invoke(tool, args as Record<string, unknown>);
    const heading = `tools${codeMember(namespace)}${codeMember(method)}`;
    outputs.push(`${heading}:\n${result}`);
    return result;
  };

  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init || declaration.init.type !== 'AwaitExpression') throw new Error('Code Mode variable declarations must await an MCP call.');
        variables.set(declaration.id.name, await runCall(declaration.init.argument));
      }
      continue;
    }
    if (statement.type === 'ExpressionStatement') {
      const expression = statement.expression;
      if (expression.type === 'AwaitExpression') { await runCall(expression.argument); continue; }
      if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' && expression.callee.object.type === 'Identifier' && expression.callee.object.name === 'console' && ['log', 'error', 'warn'].includes(expression.callee.property.name)) {
        outputs.push(expression.arguments.map((argument: any) => String(evaluate(argument) ?? '')).join(' '));
        continue;
      }
      throw new Error('Only awaited MCP calls and console.log(...) statements are allowed.');
    }
    if (statement.type === 'ReturnStatement' && statement.argument) { outputs.push(String(evaluate(statement.argument) ?? '')); continue; }
    if (statement.type === 'EmptyStatement') continue;
    throw new Error(`Code Mode does not allow ${statement.type} statements.`);
  }
  return outputs.join('\n\n').slice(0, 32_000) || 'Code Mode completed without producing output.';
}

