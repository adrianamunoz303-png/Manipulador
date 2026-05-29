'use strict';
// ══════════════════════════════════════════════════════════════
// Servidor HMI — Manipulador Lineal (standalone, sin Moule3D)
// node server-manipulator.js
// ══════════════════════════════════════════════════════════════

const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { spawn }   = require('child_process');
const manipulator = require('./manipulator-serial');

const PORT       = Number(process.env.PORT || 3001);
const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// ── Tipos MIME ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.stl':  'model/stl',
  '.ico':  'image/x-icon',
};

// ── Helpers ─────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) reject(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── Servidor HTTP ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS para desarrollo local
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url      = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ── API del manipulador ──────────────────────────────────

    if (pathname === '/api/manipulator/ports' && req.method === 'GET') {
      const ports = await manipulator.listPorts();
      return sendJson(res, 200, { ok: true, ports });
    }

    if (pathname === '/api/manipulator/status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...manipulator.getStatus() });
    }

    if (pathname === '/api/manipulator/connect' && req.method === 'POST') {
      const body = await readBody(req);
      const portPath = String(body.port || '').trim();
      const baudRate = Number(body.baudRate || 9600);
      if (!portPath) return sendJson(res, 400, { ok: false, message: 'Puerto requerido' });
      try {
        await manipulator.connect(portPath, baudRate);
        return sendJson(res, 200, { ok: true, message: `Conectado a ${portPath}` });
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: e.message });
      }
    }

    if (pathname === '/api/manipulator/disconnect' && req.method === 'POST') {
      await manipulator.disconnect();
      return sendJson(res, 200, { ok: true, message: 'Desconectado' });
    }

    if (pathname === '/api/manipulator/command' && req.method === 'POST') {
      const body = await readBody(req);
      const cmd = String(body.cmd || '').trim();
      if (!cmd) return sendJson(res, 400, { ok: false, message: 'Comando requerido' });
      try {
        const sent = manipulator.sendCommand(cmd);
        return sendJson(res, 200, { ok: true, sent });
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: e.message });
      }
    }

    // SSE — eventos en tiempo real desde el Arduino
    if (pathname === '/api/manipulator/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':\n\n');
      manipulator.addSSEClient(res);
      const hb = setInterval(() => { try { res.write(':\n\n'); } catch { clearInterval(hb); } }, 15000);
      req.on('close', () => { clearInterval(hb); manipulator.removeSSEClient(res); });
      return;
    }

    // Nube de puntos del volumen de trabajo
    if (pathname === '/api/manipulator/workspace-cloud' && req.method === 'GET') {
      const cloudPath = path.join(PUBLIC_DIR, 'workspace_cloud.json');
      if (!fs.existsSync(cloudPath)) {
        return sendJson(res, 404, { ok: false, message: 'workspace_cloud.json no generado.' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      fs.createReadStream(cloudPath).pipe(res);
      return;
    }

    // Calcular workspace (requiere Python + workspace_export.py)
    if (pathname === '/api/manipulator/workspace-compute' && req.method === 'POST') {
      const body   = await readBody(req);
      const maxPts = Math.max(1000, Math.min(200000, parseInt(body.max_pts || 60000)));
      const script = path.join(ROOT_DIR, 'workspace_export.py');
      if (!fs.existsSync(script)) {
        return sendJson(res, 404, { ok: false, message: 'workspace_export.py no encontrado' });
      }
      const outFile = path.join(PUBLIC_DIR, 'workspace_cloud.json');
      const child = spawn('python3', [script, '--max-pts', String(maxPts), '--out', outFile], { cwd: ROOT_DIR });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        if (code === 0) sendJson(res, 200, { ok: true, message: stdout.trim() });
        else sendJson(res, 500, { ok: false, message: (stderr || stdout).trim() || 'Error al calcular workspace' });
      });
      return;
    }

    // Lagrange-Euler (requiere Python + lagrange_euler.py)
    if (pathname === '/api/manipulator/lagrange-euler' && req.method === 'POST') {
      const body    = await readBody(req);
      const tmpFile = path.join(os.tmpdir(), `le_input_${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(body));
      const script  = path.join(ROOT_DIR, 'lagrange_euler.py');
      if (!fs.existsSync(script)) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return sendJson(res, 404, { ok: false, message: 'lagrange_euler.py no encontrado' });
      }
      const child = spawn('python3', [script, '--api', tmpFile], { cwd: ROOT_DIR });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (code === 0) {
          try { sendJson(res, 200, JSON.parse(stdout.trim())); }
          catch { sendJson(res, 500, { ok: false, message: 'Error parseando resultado Python', raw: stdout.slice(0, 500) }); }
        } else {
          sendJson(res, 500, { ok: false, message: (stderr || stdout).trim().slice(0, 800) || 'Error en Lagrange-Euler' });
        }
      });
      return;
    }

    // ── Archivos estáticos ──────────────────────────────────

    // Raíz y /manipulator → sirve manipulator.html
    if (pathname === '/' || pathname === '/manipulator' || pathname === '/manipulator.html') {
      return serveFile(res, path.join(ROOT_DIR, 'manipulator.html'));
    }

    // Cualquier otro archivo en public/
    const staticPath = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFile(res, staticPath);
    }

    // Archivos en la raíz del proyecto (STL, imágenes, etc.)
    const rootPath = path.join(ROOT_DIR, pathname.replace(/^\//, ''));
    if (fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()) {
      return serveFile(res, rootPath);
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error('[server]', e.message);
    sendJson(res, 500, { ok: false, message: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  HMI Manipulador Lineal              ║`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  // Abrir navegador automáticamente
  const url = `http://localhost:${PORT}`;
  const open = process.platform === 'win32'  ? ['cmd', ['/c', 'start', url]]
             : process.platform === 'darwin' ? ['open', [url]]
             : ['xdg-open', [url]];
  try { spawn(open[0], open[1], { detached: true, stdio: 'ignore' }); } catch {}
});
