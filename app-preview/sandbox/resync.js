// Tiny resync endpoint for the sf-ngv0-sandbox pod.
//
// POST /resync  (optional body {"sha": "<git sha>"}) — git fetch + reset --hard
//   the workspace to <sha> (or the fetched tip if omitted), so the Angular dev
//   server's file watcher fires HMR. Returns 200 {ok:true,ref} on success.
// GET  /healthz — liveness probe.
//
// execFile with an argv array (never a shell string) keeps the sha out of any
// shell; the sha is additionally validated as hex before use.
'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');

const WORKSPACE = process.env.WORKSPACE || '/workspace';
const PORT = parseInt(process.env.RESYNC_PORT || '8090', 10);
const SHA_RE = /^[0-9a-fA-F]{4,40}$/;

function git(args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', WORKSPACE, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '') + (stderr || '') });
    });
  });
}

async function resync(sha) {
  // Fetch the requested object if a sha was given (so it exists locally after a
  // shallow clone); otherwise refresh the cloned branch. Fetch errors are
  // tolerated — the reset below is the real success signal.
  await git(sha ? ['fetch', '--depth', '1', 'origin', sha] : ['fetch', 'origin']);
  const target = sha || 'FETCH_HEAD';
  const reset = await git(['reset', '--hard', target]);
  return { ok: reset.ok, ref: target, detail: reset.ok ? undefined : reset.out.slice(-400) };
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/resync') return send(404, { error: 'not found' });

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let sha = null;
    if (body.trim()) {
      try {
        const raw = (JSON.parse(body).sha || '').trim();
        sha = raw || null;
      } catch {
        return send(400, { error: 'invalid JSON body' });
      }
    }
    if (sha && !SHA_RE.test(sha)) return send(400, { error: 'invalid sha' });
    const result = await resync(sha);
    send(result.ok ? 200 : 500, result);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[resync] listening on :${PORT} (workspace ${WORKSPACE})`);
});
