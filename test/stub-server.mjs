// Stub OpenViking server for the omp-openviking smoke test.
// Zero dependencies, node:http only. Logs every request as one JSON line so
// test/smoke.mjs can assert which endpoints the extension hit.
//
// Contract shared with test/smoke.mjs: same port override (STUB_PORT), same
// log path override (STUB_LOG), same canary override (STUB_CANARY).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_LOG = path.join(REPO_ROOT, 'test', '.artifacts', 'requests.jsonl');
const DEFAULT_CANARY = 'OPENVIKING-CANARY-DEFAULT';

function now() {
  return new Date().toISOString();
}

function sendJson(res, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(payload);
}

// Plausible response bodies per route. Shapes follow the OpenViking HTTP API
// closely enough for the vendored client to parse them without falling over.
function searchResponse(canary) {
  return {
    rendered: `Search results (stub):\n\n1. ${canary} memory match\n`,
    digest: '',
    entries: [
      {
        uri: 'viking://stub/memory/canary',
        category: 'memory',
        detail: 'full',
        score: 0.91,
        text: `Stub memory entry containing the canary ${canary}.`,
      },
    ],
    stats: {
      used_tokens: 128,
      tier_counts: { l0: 0, l1: 1, l2: 0 },
      rewrite: 'off',
    },
  };
}

function findResponse(canary) {
  return {
    memories: [
      {
        uri: 'viking://stub/memory/canary',
        abstract: `Stub memory abstract with canary ${canary}.`,
        score: 0.87,
      },
    ],
    resources: [],
    skills: [],
    total: 1,
  };
}

function statusResponse() {
  return {
    status: 'ok',
    version: '0.4.20-stub',
    uptime_seconds: 42,
    endpoints: { api: true, search: true },
  };
}

function lsResponse(query) {
  return {
    uri: typeof query.uri === 'string' ? query.uri : 'viking://stub/',
    entries: [],
    truncated: false,
  };
}

function readResponse(query, canary) {
  const markdown = `# Stub Document\n\nMarkdown text served by the stub. Canary: ${canary}.\n`;
  return {
    uri: typeof query.uri === 'string' ? query.uri : 'viking://stub/memory/canary',
    content: markdown,
    format: 'markdown',
    size: markdown.length,
  };
}

function sessionResponse(id) {
  return {
    id,
    created: true,
    archive_overview: [],
    message_count: 0,
  };
}

function sessionOverview(id) {
  return {
    id,
    archive_overview: [],
    context: '',
    tokens: 0,
  };
}

function messagesBatchResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    accepted: true,
    count: messages.length,
    ids: messages.map((_, i) => `stub-msg-${i + 1}`),
  };
}

function commitResponse() {
  return {
    committed: true,
    added: 1,
    updated: 0,
    removed: 0,
  };
}

function contextResponse() {
  return {
    context: '',
    tokens: 0,
    archive_overview: [],
  };
}


// --------------------------------------------------------------------- MCP
// Streamable HTTP (spec revision 2025-06-18), hand-rolled over node:http.
// Only the MCP *client* package is installed (see package.json), not a
// server SDK, so this is a minimal from-scratch implementation of just
// enough of the transport for @modelcontextprotocol/client's
// StreamableHTTPClientTransport to complete a handshake and drive tool
// calls. It is intentionally stateless: every initialize mints a fresh
// mcp-session-id and no session table is kept, so nothing here can reject a
// session id the real client sends back to us.

const MCP_PROTOCOL_VERSION = '2025-06-18';

const MCP_TOOLS = [
  {
    name: 'search',
    description: 'Search OpenViking memory (stub).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'read',
    description: 'Read an OpenViking resource by URI (stub).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'browse',
    description: 'Browse an OpenViking URI tree (stub).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'remember',
    description: 'Store a memory entry (stub).',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' }, tags: { type: 'string' } },
      required: ['content'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a memory entry by URI (stub).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'add_resource',
    description: 'Attach a resource to OpenViking (stub).',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' }, title: { type: 'string' } },
      required: ['uri'],
    },
  },
  {
    name: 'archive_expand',
    description: 'Expand an archived overview entry (stub).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

// search mirrors searchResponse().rendered so a model quoting a tool result
// back sees the same canary shape whether it went through REST or MCP.
function mcpToolResultText(name, args, canary) {
  if (name === 'search') {
    const query = args && typeof args.query === 'string' ? args.query : '';
    return `Search results (stub):\n\n1. ${canary} memory match\n` + (query ? `(query: ${query})\n` : '');
  }
  return `${name}: ok (stub)`;
}

function sendMcpJson(res, status, obj, extraHeaders = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(payload);
}

// GET /mcp -> 405. StreamableHTTPClientTransport opens this standalone
// stream right after sending notifications/initialized; on a 405 it just
// ends that attempt (onRequestStreamEnd) without surfacing an error, so a
// plain 405 is the least code that still keeps the real client happy —
// no second, mostly idle SSE stream to maintain.
function handleMcpGet(req, res) {
  res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } }));
}

// DELETE /mcp -> 200. Stateless stub: every teardown succeeds, there is
// nothing to invalidate.
function handleMcpDelete(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
}

function handleMcpPost(req, res, body, canary) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendMcpJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: expected a JSON-RPC object' },
    });
  }

  const isNotification = !('id' in body);
  const { method, params, id } = body;

  if (isNotification) {
    // e.g. notifications/initialized: no reply body, 202 per spec.
    res.writeHead(202);
    return res.end();
  }

  if (method === 'initialize') {
    const sessionId = randomUUID();
    return sendMcpJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'openviking-stub', version: '0.0.0' },
        },
      },
      { 'mcp-session-id': sessionId },
    );
  }

  if (method === 'tools/list') {
    return sendMcpJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
  }

  if (method === 'tools/call') {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const known = MCP_TOOLS.some((tool) => tool.name === name);
    if (!known) {
      return sendMcpJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
    }
    const args = params && typeof params.arguments === 'object' && params.arguments ? params.arguments : {};
    const text = mcpToolResultText(name, args, canary);
    return sendMcpJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], isError: false },
    });
  }

  return sendMcpJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

export function startStubServer({
  port = Number(process.env.STUB_PORT) || 1933,
  logPath = process.env.STUB_LOG || DEFAULT_LOG,
  canary = process.env.STUB_CANARY || DEFAULT_CANARY,
} = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');

  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = { raw };
        }
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const query = Object.fromEntries(url.searchParams.entries());
      const line = JSON.stringify({
        ts: now(),
        method: req.method,
        path: url.pathname,
        query,
        body,
      });
      try {
        fs.appendFileSync(logPath, line + '\n');
      } catch {
        // Logging must never take the stub down.
      }

      try {
        route(req, res, url, query, body, canary);
      } catch (err) {
        // Never crash on a bad request: log and answer an empty object.
        try {
          fs.appendFileSync(
            logPath,
            JSON.stringify({ ts: now(), error: String(err && err.message ? err.message : err) }) + '\n',
          );
        } catch {}
        sendJson(res, {});
      }
    });
    req.on('error', () => sendJson(res, {}));
  });

  function route(req, res, url, query, body, canary) {
    const { pathname } = url;
    const method = req.method || 'GET';

    if (pathname === '/mcp') {
      if (method === 'GET') return handleMcpGet(req, res);
      if (method === 'DELETE') return handleMcpDelete(req, res);
      if (method === 'POST') return handleMcpPost(req, res, body, canary);
      return sendJson(res, {});
    }

    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, { status: 'ok', version: 'stub' });
    }
    if (method === 'GET' && pathname === '/api/v1/system/status') {
      return sendJson(res, statusResponse());
    }
    if (method === 'GET' && pathname === '/api/v1/fs/ls') {
      return sendJson(res, lsResponse(query));
    }
    if (method === 'GET' && pathname === '/api/v1/content/read') {
      return sendJson(res, readResponse(query, canary));
    }

    if (method === 'POST' && pathname === '/api/v1/search/search') {
      return sendJson(res, searchResponse(canary));
    }
    if (method === 'POST' && pathname === '/api/v1/search/find') {
      return sendJson(res, findResponse(canary));
    }

    if (method === 'POST' && pathname === '/api/v1/sessions') {
      const id =
        body && typeof body === 'object' && typeof body.id === 'string' && body.id.length > 0
          ? body.id
          : 'stub-session';
      return sendJson(res, sessionResponse(id));
    }

    if (method === 'POST' && pathname.includes('/messages/batch')) {
      return sendJson(res, messagesBatchResponse(body));
    }
    if (method === 'POST' && pathname.includes('/commit')) {
      return sendJson(res, commitResponse());
    }
    if (method === 'POST' && pathname.includes('/context')) {
      return sendJson(res, contextResponse());
    }

    if (pathname.startsWith('/api/v1/sessions/')) {
      const id = pathname.split('/')[4] || 'stub-session';
      if (method === 'GET' || method === 'POST') {
        return sendJson(res, sessionOverview(id));
      }
      return sendJson(res, {});
    }

    return sendJson(res, {});
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        logPath,
        close() {
          return new Promise((resolveClose) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startStubServer().then((stub) => {
    console.log(`stub listening on ${stub.url} logging to ${stub.logPath} canary=${process.env.STUB_CANARY || DEFAULT_CANARY}`);
    const shutdown = () => {
      stub.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
