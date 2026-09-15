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

    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, { status: 'ok' });
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
