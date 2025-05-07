/* ------------------------------------------------------------------
   Express/SSE wrapper for Sequential-Thinking MCP server
-------------------------------------------------------------------*/
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import bodyParser from 'body-parser';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// Track user → { process, lastActivity, sseRes }
const userSessions = new Map();
const MAX_INACTIVE = 15 * 60 * 1000;          // 15 minutes

/* ─────────────  helper  ───────────── */
function killSession(userId, reason = 'timeout') {
  const sess = userSessions.get(userId);
  if (!sess) return;
  console.log(`[${userId}] session end (${reason})`);
  try { sess.process.kill(); } catch {/* noop */}
  sess.sseRes?.end();
  userSessions.delete(userId);
}

/* ─────────────  cleanup loop  ───────────── */
setInterval(() => {
  const now = Date.now();
  for (const [uid, sess] of userSessions.entries()) {
    if (now - sess.lastActivity > MAX_INACTIVE) killSession(uid);
  }
}, 60_000);

/* ─────────────  SSE endpoint  ───────────── */
app.get('/sse', (req, res) => {
  const userId = req.header('x-user-id');
  if (!userId) return res.status(400).send('Missing X-User-ID');

  // One active SSE stream per user; replace if needed
  if (userSessions.has(userId)) killSession(userId, 'reconnect');

  console.log(`[${userId}] SSE connected`);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  /* spawn MCP child process (stdio transport) */
  const child = spawn('node', ['dist/index.js'], { cwd: __dirname });
  child.stderr.pipe(process.stderr);

  // Forward every JSON-RPC line (stdout) → SSE
  child.stdout.on('data', (chunk) => {
    chunk.toString().split(/\r?\n/).forEach(line => {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    });
  });

  child.on('exit', () => killSession(userId, 'child-exit'));
  child.on('error', (e) => {
    console.error(`[${userId}] child error`, e);
    killSession(userId, 'child-error');
  });

  // Save session object
  userSessions.set(userId, { process: child, lastActivity: Date.now(), sseRes: res });

  // Close handler
  req.on('close', () => killSession(userId, 'client-disconnect'));
});

/* ─────────────  client → server messages  ───────────── */
app.post('/message', (req, res) => {
  const userId = req.header('x-user-id');
  const session = userSessions.get(userId);
  if (!session) return res.status(404).send('Session not found');

  try {
    session.process.stdin.write(JSON.stringify(req.body) + '\n');
    session.lastActivity = Date.now();
    return res.sendStatus(202);
  } catch (e) {
    console.error(`[${userId}] write error`, e);
    killSession(userId, 'stdin-write');
    return res.status(500).send('failed');
  }
});

/* ─────────────  health check  ───────────── */
app.get('/health', (_, res) => {
  res.json({ status: 'ok', sessions: userSessions.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wrapper listening on :${PORT}`)); 