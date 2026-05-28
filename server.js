require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const twilio = require('twilio');
const manipulator = require('./manipulator-serial');

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const SESSION_SECRET = process.env.SESSION_SECRET || 'moule3d-change-this-secret';
if (!process.env.SESSION_SECRET) {
  console.warn('[ADVERTENCIA] SESSION_SECRET no configurado. Define la variable de entorno SESSION_SECRET para produccion.');
}

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DASHBOARD_FILE = path.join(DATA_DIR, 'dashboard.json');
const STOCK_FILE = path.join(DATA_DIR, 'stock.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const CLIENT_PROFILES_FILE = path.join(DATA_DIR, 'client_profiles.json');
const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json');
const QUOTE_SERIALS_FILE = path.join(DATA_DIR, 'quote_serials.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const PRINTERS_FILE = path.join(DATA_DIR, 'printers.json');
const CALCULATOR_HISTORY_FILE = path.join(DATA_DIR, 'calculator_history.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const STL_DIR = path.join(os.homedir(), 'Documents', 'Moule3D', 'STL');
const STL_META_FILE = path.join(DATA_DIR, 'stl_meta.json');
const ALERT_STATE_FILE = path.join(DATA_DIR, 'alert_state.json');

// ── WhatsApp notifications (Twilio) ─────────────────────────────────────────
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_WA_FROM = process.env.TWILIO_WA_FROM || ''; // whatsapp:+14155238886 (sandbox)
const WA_RECIPIENTS = [
  process.env.WA_RECIPIENT_1 || '', // whatsapp:+57XXXXXXXXXX
  process.env.WA_RECIPIENT_2 || ''  // whatsapp:+57XXXXXXXXXX
].filter(Boolean);
// Alertas: 480 min (8h) = advertencia, 120 min (2h) = crítica
const ALERT_THRESHOLD_WARNING_MIN = 480;
const ALERT_THRESHOLD_CRITICAL_MIN = 120;
const ALERT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // cada 15 min

const FDM_STOCK_MATERIALS = new Set(['pla', 'pla_pro', 'petg', 'elastico', 'tpu', 'abs']);
const RESIN_STOCK_MATERIALS = new Set([
  'estandar',
  'flex',
  'high_speed',
  'casteable',
  'alta_dureza',
  'biocompatible'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.stl': 'model/stl'
};

ensureSeedFiles();
backfillClientsFromCalculatorQuotes();
backfillQuoteLinksAndApprovedTasks();
ensureQuoteSerialState();
fs.mkdirSync(STL_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = normalizePathname(url.pathname);

    if (pathname === '/api/login' && req.method === 'POST') {
      return handleLogin(req, res);
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return sendJson(res, 200, {
        ok: true,
        user: {
          email: session.email,
          name: session.name,
          role: session.role
        }
      });
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleDashboardGet(res, session);
    }

    if ((pathname === '/api/stock' || pathname === '/api/stocks') && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStockGet(res);
    }

    if (
      (pathname === '/api/stock/consume' || pathname === '/api/stocks/consume') &&
      req.method === 'POST'
    ) {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStockConsume(req, res);
    }

    if (
      (pathname === '/api/stock' ||
        pathname === '/api/stock/add' ||
        pathname === '/api/stocks' ||
        pathname === '/api/stocks/add') &&
      req.method === 'POST'
    ) {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStockAdd(req, res);
    }

    if (
      (pathname === '/api/stock/delete' || pathname === '/api/stocks/delete') &&
      req.method === 'POST'
    ) {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStockDelete(req, res);
    }

    if (pathname === '/api/clients' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientsGet(res);
    }

    if (pathname === '/api/clients' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientsCreate(req, res);
    }

    if (pathname === '/api/clients/status' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientsStatus(req, res);
    }

    if (pathname === '/api/clients/cost' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientsCost(req, res);
    }

    if (pathname === '/api/clients/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientsDelete(req, res);
    }

    if (pathname === '/api/client-profiles' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientProfilesGet(res);
    }

    if (pathname === '/api/client-profiles' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientProfilesUpsert(req, res);
    }

    if (pathname === '/api/client-profiles/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleClientProfilesDelete(req, res);
    }

    if (pathname === '/api/quotes' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleQuotesGet(res);
    }

    if (pathname === '/api/quotes' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleQuotesCreate(req, res);
    }

    if (pathname === '/api/quotes/approve' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleQuotesApprove(req, res);
    }

    if (pathname === '/api/quotes/unapprove' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleQuotesUnapprove(req, res);
    }

    if (pathname === '/api/quotes/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleQuotesDelete(req, res);
    }

    if (pathname === '/api/calculator/history' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleCalculatorHistoryGet(res);
    }

    if (pathname === '/api/calculator/history' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleCalculatorHistoryUpsert(req, res);
    }

    if (pathname === '/api/calculator/history/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleCalculatorHistoryDelete(req, res);
    }

    if (pathname === '/api/tasks' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleTasksGet(res);
    }

    if (pathname === '/api/tasks' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleTasksCreate(req, res);
    }

    if (pathname === '/api/tasks/status' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleTasksStatus(req, res);
    }

    if (pathname === '/api/tasks/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleTasksDelete(req, res);
    }

    if (pathname === '/api/stl/upload' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStlUpload(req, res);
    }

    if (pathname === '/api/stl/files' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleStlFiles(req, res, url);
    }

    if (pathname === '/api/stl/serve' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) return;
      return handleStlServe(req, res, url);
    }

    if (pathname === '/api/stl/meta' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) return;
      return handleStlMetaSave(req, res);
    }

    if (pathname === '/api/stl/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) return;
      return handleStlDelete(req, res);
    }

    if (pathname === '/api/printers' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handlePrintersGet(res);
    }

    if (pathname === '/api/printers/update' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handlePrintersUpdate(req, res);
    }

    if (pathname === '/api/accounts' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleAccountsGet(res);
    }

    if (pathname === '/api/accounts/entries' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleAccountsEntryUpsert(req, res);
    }

    if (pathname === '/api/accounts/entries/delete' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleAccountsEntryDelete(req, res);
    }

    if (pathname === '/api/accounts/payables' && req.method === 'POST') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleAccountsPayablesUpdate(req, res);
    }

    if (pathname === '/api/reports' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      return handleReportsGet(url, res);
    }

    // ── MANIPULADOR LINEAL ─────────────────────────────────────
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

    // SSE — stream en tiempo real desde el Arduino
    if (pathname === '/api/manipulator/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':\n\n'); // comentario SSE para mantener conexión
      manipulator.addSSEClient(res);
      const hb = setInterval(() => { try { res.write(':\n\n'); } catch { clearInterval(hb); } }, 15000);
      req.on('close', () => { clearInterval(hb); manipulator.removeSSEClient(res); });
      return;
    }
    // ── Workspace cloud (Python export) ────────────────────────
    if (pathname === '/api/manipulator/workspace-cloud' && req.method === 'GET') {
      const cloudPath = path.join(PUBLIC_DIR, 'workspace_cloud.json');
      if (!fs.existsSync(cloudPath)) {
        return sendJson(res, 404, {
          ok: false,
          message: 'workspace_cloud.json no generado. Ejecuta workspace_export.py o usa el botón "Calcular (Pi)".',
        });
      }
      const data = fs.readFileSync(cloudPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
      return;
    }

    if (pathname === '/api/manipulator/workspace-compute' && req.method === 'POST') {
      const body = await readBody(req);
      const maxPts  = Math.max(1000, Math.min(200000, parseInt(body.max_pts || 60000)));
      const script  = path.join(ROOT_DIR, 'workspace_export.py');
      if (!fs.existsSync(script)) {
        return sendJson(res, 404, { ok: false, message: 'workspace_export.py no encontrado en ' + ROOT_DIR });
      }
      const { spawn } = require('child_process');
      const outFile = path.join(PUBLIC_DIR, 'workspace_cloud.json');
      const child = spawn('python3', [
        script, '--max-pts', String(maxPts), '--out', outFile,
      ], { cwd: ROOT_DIR });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        if (code === 0) {
          sendJson(res, 200, { ok: true, message: stdout.trim() });
        } else {
          sendJson(res, 500, { ok: false, message: (stderr || stdout).trim() || 'Error al calcular workspace' });
        }
      });
      return;
    }
    if (pathname === '/api/manipulator/lagrange-euler' && req.method === 'POST') {
      const body = await readBody(req);
      const tmpFile = path.join(os.tmpdir(), `le_input_${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(body));
      const script = path.join(ROOT_DIR, 'lagrange_euler.py');
      if (!fs.existsSync(script)) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return sendJson(res, 404, { ok: false, message: 'lagrange_euler.py no encontrado en ' + ROOT_DIR });
      }
      const { spawn } = require('child_process');
      const child = spawn('python3', [script, '--api', tmpFile], { cwd: ROOT_DIR });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (code === 0) {
          try {
            const result = JSON.parse(stdout.trim());
            sendJson(res, 200, result);
          } catch {
            sendJson(res, 500, { ok: false, message: 'Error parseando resultado Python', raw: stdout.slice(0, 500) });
          }
        } else {
          sendJson(res, 500, { ok: false, message: (stderr || stdout).trim().slice(0, 800) || 'Error en cálculo Lagrange-Euler' });
        }
      });
      return;
    }

    // ── FIN MANIPULADOR ────────────────────────────────────────

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, {
        ok: false,
        message: `Ruta no encontrada (${req.method} ${pathname})`
      });
    }

    return serveStatic(pathname, res);
  } catch (error) {
    console.error('Unhandled server error:', error);
    return sendJson(res, 500, { ok: false, message: 'Error interno del servidor' });
  }
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Moule 3D panel listo en http://${HOST === '0.0.0.0' ? '0.0.0.0 (toda la red)' : HOST}:${PORT}`);
  startAlertScheduler();
});

async function handleLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) {
    return sendJson(res, 400, { ok: false, message: 'Correo y contrasena son obligatorios' });
  }

  const db = readJson(USERS_FILE, { users: [] });
  const user = (db.users || []).find((item) => String(item.email || '').toLowerCase() === email);

  if (!user || user.active === false) {
    return sendJson(res, 401, { ok: false, message: 'Credenciales invalidas' });
  }

  if (!verifyPassword(password, user.salt, user.passwordHash)) {
    return sendJson(res, 401, { ok: false, message: 'Credenciales invalidas' });
  }

  const sessionToken = createSessionToken({
    email: user.email,
    name: user.name || 'Usuario',
    role: user.role || 'operator'
  });

  setSessionCookie(res, sessionToken);

  return sendJson(res, 200, {
    ok: true,
    user: {
      email: user.email,
      name: user.name || 'Usuario',
      role: user.role || 'operator'
    }
  });
}

function handleDashboardGet(res, session) {
  const dashboardBase = readJson(DASHBOARD_FILE, defaultDashboard());
  const clients = readJson(CLIENTS_FILE, { clients: [] });
  const normalizedClients = normalizeClients(clients.clients);

  const summary = buildSummaryFromBaseAndClients(dashboardBase, normalizedClients);
  const monthlyRevenue = buildMonthlyRevenueFromBaseAndClients(dashboardBase.monthlyRevenue, normalizedClients);
  const orders = buildOrdersFromBaseAndClients(dashboardBase.orders, normalizedClients);

  return sendJson(res, 200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary,
    monthlyRevenue,
    orders,
    user: {
      email: session.email,
      name: session.name,
      role: session.role
    }
  });
}

function handleStockGet(res) {
  const stock = readJson(STOCK_FILE, defaultStock());
  const items = normalizeStock(stock.items);
  return sendJson(res, 200, { ok: true, items });
}

async function handleStockAdd(req, res) {
  const body = await readBody(req);
  const category = normalizeStockCategory(
    body.category,
    body.process || body.type || body.mode,
    body.material
  );

  const stock = readJson(STOCK_FILE, defaultStock());
  const items = normalizeStock(stock.items);

  if (category === 'materiales') {
    const process = normalizeStockProcess(body.process || body.type || body.mode, body.material);
    const material = resolveStockMaterial(
      process,
      body.material,
      process === 'resina' ? 'estandar' : 'pla'
    );
    const color = sanitizeText(body.color, 40);
    const grams = parseGrams(body.grams);

    if (!color) {
      return sendJson(res, 400, { ok: false, message: 'Color requerido' });
    }

    if (!Number.isFinite(grams) || grams <= 0) {
      return sendJson(res, 400, { ok: false, message: 'Gramos invalidos' });
    }

    upsertMaterialStock(items, process, material, color, grams);
    writeJson(STOCK_FILE, { items });

    return sendJson(res, 200, {
      ok: true,
      message: `Stock agregado: +${grams} g de ${color} (${stockProcessLabel(process)} / ${stockMaterialLabel(material)})`,
      items
    });
  }

  const name = sanitizeText(body.name || body.item || body.description, 80);
  const quantity = parseCount(body.quantity ?? body.units ?? body.amount);

  if (!name) {
    return sendJson(res, 400, { ok: false, message: 'Nombre/referencia requerido' });
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return sendJson(res, 400, { ok: false, message: 'Cantidad invalida' });
  }

  upsertGeneralStock(items, category, name, quantity);
  writeJson(STOCK_FILE, { items });

  return sendJson(res, 200, {
    ok: true,
    message: `Stock agregado: +${quantity} und de ${name} (${stockCategoryLabel(category)})`,
    items
  });
}

async function handleStockDelete(req, res) {
  const body = await readBody(req);
  const category = normalizeStockCategory(
    body.category,
    body.process || body.type || body.mode,
    body.material
  );
  const stock = readJson(STOCK_FILE, defaultStock());
  const items = normalizeStock(stock.items);

  if (category === 'materiales') {
    const process = normalizeStockProcess(body.process || body.type || body.mode, body.material);
    const material = resolveStockMaterial(
      process,
      body.material,
      process === 'resina' ? 'estandar' : 'pla'
    );
    const color = sanitizeText(body.color, 40);

    if (!color) {
      return sendJson(res, 400, { ok: false, message: 'Color requerido para eliminar' });
    }

    const index = findStockIndex(items, process, material, color);
    if (index < 0) {
      return sendJson(res, 404, {
        ok: false,
        message: `No existe stock para ${stockProcessLabel(process)} / ${stockMaterialLabel(material)} / ${color}`
      });
    }

    const removed = items[index];
    items.splice(index, 1);
    writeJson(STOCK_FILE, { items });

    return sendJson(res, 200, {
      ok: true,
      message: `Eliminado: ${removed.color} (${stockProcessLabel(removed.process)} / ${stockMaterialLabel(removed.material)})`,
      items
    });
  }

  const name = sanitizeText(body.name || body.item || body.description, 80);
  if (!name) {
    return sendJson(res, 400, { ok: false, message: 'Nombre/referencia requerido para eliminar' });
  }

  const index = findGeneralStockIndex(items, category, name);
  if (index < 0) {
    return sendJson(res, 404, {
      ok: false,
      message: `No existe item en ${stockCategoryLabel(category)} con nombre ${name}`
    });
  }

  const removed = items[index];
  items.splice(index, 1);
  writeJson(STOCK_FILE, { items });

  return sendJson(res, 200, {
    ok: true,
    message: `Eliminado: ${removed.name} (${stockCategoryLabel(removed.category)})`,
    items
  });
}

async function handleStockConsume(req, res) {
  const body = await readBody(req);
  const color = sanitizeText(body.color, 40);
  const grams = parseGrams(body.grams);
  const rawProcess = sanitizeText(body.process || body.type || body.mode, 20).toLowerCase();
  const rawMaterial = sanitizeText(body.material, 40).toLowerCase();
  let process = normalizeStockProcess(rawProcess, rawMaterial);
  let material = resolveStockMaterial(
    process,
    rawMaterial,
    process === 'resina' ? 'estandar' : 'pla'
  );

  if (!color) {
    return sendJson(res, 400, { ok: false, message: 'Color requerido' });
  }

  if (!Number.isFinite(grams) || grams <= 0) {
    return sendJson(res, 400, { ok: false, message: 'Gramos invalidos para descontar' });
  }

  const stock = readJson(STOCK_FILE, defaultStock());
  const items = normalizeStock(stock.items);
  let index = -1;

  if (rawProcess || rawMaterial) {
    index = findStockIndex(items, process, material, color);
  } else {
    const colorMatches = items.filter(
      (item) =>
        item.category === 'materiales' &&
        String(item.color || '').toLowerCase() === String(color).toLowerCase()
    );

    if (colorMatches.length > 1) {
      return sendJson(res, 409, {
        ok: false,
        message: 'Color repetido en varios materiales. Indica tipo y material para descontar stock.'
      });
    }

    if (colorMatches.length === 1) {
      const found = colorMatches[0];
      process = found.process;
      material = found.material;
      index = findStockIndex(items, process, material, color);
    }
  }

  if (index < 0) {
    return sendJson(res, 404, {
      ok: false,
      message: `No existe stock para ${stockProcessLabel(process)} / ${stockMaterialLabel(material)} / ${color}`
    });
  }

  const available = items[index].grams;
  if (available < grams) {
    return sendJson(res, 409, {
      ok: false,
      message: `Stock insuficiente en ${stockProcessLabel(items[index].process)} / ${stockMaterialLabel(items[index].material)} / ${items[index].color}. Disponible: ${available} g`
    });
  }

  items[index].grams = roundTwo(available - grams);
  writeJson(STOCK_FILE, { items });

  return sendJson(res, 200, {
    ok: true,
    message: `Aprobado. Descontados ${grams} g de ${items[index].color} (${stockProcessLabel(items[index].process)} / ${stockMaterialLabel(items[index].material)})`,
    remaining: items[index].grams,
    items
  });
}

function handleClientsGet(res) {
  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sendJson(res, 200, { ok: true, clients });
}

async function handleClientsCreate(req, res) {
  const body = await readBody(req);

  const source = normalizeRecordSource(body.source, 'manual');
  const quoteId = sanitizeText(body.quoteId, 40);
  const quoteRef = sanitizeText(body.quoteRef, 80);
  const client = sanitizeText(body.client, 80);
  const product = sanitizeText(body.product, 120);
  const machine = sanitizeText(body.machine, 60) || 'Sin asignar';
  const status = normalizeStatus(body.status || (source === 'calculadora' ? 'quoted' : 'pending'));
  const dueAt = resolveDueDateFromBody(body.dueAt);
  const quotedValue = parseMoney(body.quotedValue);
  const saleValue = parseMoney(body.saleValue);
  const costs = parseClientCostFields(body);
  const { electricityCost: inputElectricityCost, operatorPay: inputOperatorPay, materialCost: inputMaterialCost } = costs;
  const costValue = costs.costValue > 0
    ? costs.costValue
    : parseMoney(inputElectricityCost + inputOperatorPay + inputMaterialCost);
  const payment = parseClientPaymentFields(body);
  const totalDue = resolveClientTotalDue({ quotedValue, saleValue });
  const paidValue = resolveNextClientPaidValue({
    currentPaidValue: 0,
    requestedPaidValue: payment.paidValue,
    isPaid: payment.isPaid,
    totalDue
  });
  const isPaid = computeClientIsPaidState(payment.isPaid, paidValue, totalDue);
  const paidAt = paidValue > 0 ? (payment.paidAt || new Date().toISOString()) : '';

  if (!client || !product || !dueAt) {
    return sendJson(res, 400, {
      ok: false,
      message: 'Cliente, producto y fecha de entrega son obligatorios'
    });
  }

  if (quotedValue <= 0 && saleValue <= 0) {
    return sendJson(res, 400, {
      ok: false,
      message: 'Debes registrar valor cotizado o valor cobrado'
    });
  }

  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients);

  clients.push({
    id: generateClientId(),
    client,
    product,
    machine,
    source,
    quoteId,
    quoteRef,
    status,
    quotedValue,
    saleValue,
    costValue,
    electricityCost: inputElectricityCost,
    operatorPay: inputOperatorPay,
    materialCost: inputMaterialCost,
    paidValue,
    isPaid,
    paidAt,
    dueAt,
    createdAt: new Date().toISOString()
  });

  const normalized = normalizeClients(clients);
  writeJson(CLIENTS_FILE, { clients: normalized });

  return sendJson(res, 200, { ok: true, message: 'Cliente/venta agregada', clients: normalized });
}

function parseClientPaymentFields(body) {
  const b = body || {};
  return {
    hasPaid:      'isPaid' in b,
    hasPaidValue: ('paidValue' in b) || ('paidAmount' in b) || ('abono' in b) || ('valorPagado' in b),
    isPaid:       normalizeClientPaymentFlag(b.isPaid),
    paidValue:    parseMoney(b.paidValue ?? b.paidAmount ?? b.abono ?? b.valorPagado),
    paidAt:       resolveDueDateFromBody(b.paidAt)
  };
}

function parseClientCostFields(body) {
  const b = body || {};
  return {
    hasCostValue:       ('costValue' in b) || ('totalCost' in b) || ('costPiece' in b) || ('costo' in b),
    hasElectricityCost: ('electricityCost' in b) || ('electricity' in b) || ('lightCost' in b) || ('luzCost' in b) || ('luz' in b),
    hasOperatorPay:     ('operatorPay' in b) || ('operatorCost' in b) || ('operarioCost' in b) || ('operario' in b),
    hasMaterialCost:    'materialCost' in b,
    costValue:          parseMoney(b.costValue ?? b.totalCost ?? b.costPiece ?? b.costo),
    electricityCost:    parseMoney(b.electricityCost ?? b.electricity ?? b.lightCost ?? b.luzCost ?? b.luz),
    operatorPay:        parseMoney(b.operatorPay ?? b.operatorCost ?? b.operarioCost ?? b.operario),
    materialCost:       parseMoney(b.materialCost)
  };
}

async function handleClientsStatus(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const status = normalizeStatus(body.status);
  const { hasPaid: hasPaidFlag, hasPaidValue: hasPaidValueFlag, isPaid: bodyIsPaid, paidValue: bodyPaidValue, paidAt: bodyPaidAt } = parseClientPaymentFields(body);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cliente requerido' });
  }

  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients);
  const index = clients.findIndex((item) => item.id === id);

  if (index < 0) {
    return sendJson(res, 404, { ok: false, message: 'Cliente no encontrado' });
  }

  const current = clients[index];
  const requestedPaidValue = hasPaidValueFlag ? bodyPaidValue : parseMoney(current.paidValue);
  const requestedIsPaid = hasPaidFlag ? bodyIsPaid : normalizeClientPaymentFlag(current.isPaid);
  let nextSaleValue = parseMoney(current.saleValue);
  if ((requestedIsPaid || requestedPaidValue > 0) && nextSaleValue <= 0) {
    nextSaleValue = Math.max(parseMoney(current.quotedValue), parseMoney(current.saleValue));
  }
  const currentTotalDue = resolveClientTotalDue({
    quotedValue: parseMoney(current.quotedValue),
    saleValue: parseMoney(nextSaleValue)
  });

  let nextPaidValue = requestedPaidValue;
  let nextIsPaid = requestedIsPaid;

  if (hasPaidFlag && nextIsPaid && nextPaidValue <= 0) {
    nextPaidValue = currentTotalDue > 0
      ? currentTotalDue
      : Math.max(parseMoney(current.quotedValue), parseMoney(current.saleValue));
  }

  if (hasPaidValueFlag && !hasPaidFlag) {
    nextIsPaid = computeClientIsPaidState(false, nextPaidValue, currentTotalDue);
  } else {
    nextIsPaid = computeClientIsPaidState(nextIsPaid, nextPaidValue, currentTotalDue);
  }

  if (nextIsPaid && currentTotalDue > 0 && nextPaidValue < currentTotalDue) {
    nextPaidValue = currentTotalDue;
  }

  const previousPaidValue = parseMoney(current.paidValue);
  const nextPaidAt = nextPaidValue > 0
    ? (
      bodyPaidAt
      || (nextPaidValue !== previousPaidValue ? new Date().toISOString() : resolveDueDateFromBody(current.paidAt))
      || new Date().toISOString()
    )
    : '';

  clients[index] = {
    ...current,
    status,
    saleValue: nextSaleValue,
    paidValue: nextPaidValue,
    isPaid: nextIsPaid,
    paidAt: nextPaidAt
  };
  const normalizedClients = normalizeClients(clients);
  writeJson(CLIENTS_FILE, { clients: normalizedClients });

  return sendJson(res, 200, {
    ok: true,
    message: nextIsPaid
      ? 'Estado actualizado y pago completo confirmado'
      : (nextPaidValue > 0 ? 'Estado actualizado y pago parcial confirmado' : 'Estado actualizado'),
    clients: normalizedClients
  });
}

async function handleClientsCost(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const source = normalizeRecordSource(body.source, '');
  const quoteId = sanitizeText(body.quoteId, 40);
  const quoteRef = sanitizeText(body.quoteRef, 80);
  const {
    hasCostValue, hasElectricityCost, hasOperatorPay, hasMaterialCost,
    costValue: requestedCostValue,
    electricityCost: requestedElectricityCost,
    operatorPay: requestedOperatorPay,
    materialCost: requestedMaterialCost
  } = parseClientCostFields(body);
  const machine = sanitizeText(body.machine, 60);

  if (!id && !quoteId && !quoteRef) {
    return sendJson(res, 400, {
      ok: false,
      message: 'Debes enviar ID de cliente, ID de cotizacion o referencia de cotizacion'
    });
  }

  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients);

  let index = -1;
  if (id) {
    index = clients.findIndex((item) => item.id === id);
  } else if (quoteId) {
    const quoteIdLower = quoteId.toLowerCase();
    index = clients.findIndex((item) => {
      if (String(item.quoteId || '').trim().toLowerCase() !== quoteIdLower) {
        return false;
      }
      if (source && normalizeRecordSource(item.source, 'manual') !== source) {
        return false;
      }
      return true;
    });
  } else {
    index = findClientIndexBySourceAndQuoteRef(clients, source, quoteRef);
  }

  if (index < 0) {
    return sendJson(res, 404, { ok: false, message: 'Cliente/venta no encontrado para actualizar costo' });
  }

  const current = clients[index];
  const nextElectricityCost = hasElectricityCost
    ? requestedElectricityCost
    : parseMoney(current.electricityCost);
  const nextOperatorPay = hasOperatorPay
    ? requestedOperatorPay
    : parseMoney(current.operatorPay);
  const nextMaterialCost = hasMaterialCost
    ? requestedMaterialCost
    : parseMoney(current.materialCost);
  const nextCostValue = hasCostValue
    ? requestedCostValue
    : parseMoney(
      parseMoney(current.costValue)
      || (nextElectricityCost + nextOperatorPay + nextMaterialCost)
    );

  clients[index] = {
    ...current,
    source: normalizeRecordSource(current.source, source || 'manual'),
    quoteId: sanitizeText(current.quoteId, 40) || quoteId,
    quoteRef: sanitizeText(current.quoteRef, 80) || quoteRef,
    machine: machine || current.machine || 'Sin asignar',
    costValue: nextCostValue,
    electricityCost: nextElectricityCost,
    operatorPay: nextOperatorPay,
    materialCost: nextMaterialCost,
    status: normalizeStatus(
      normalizeStatus(current.status) === 'quoted' && parseMoney(current.saleValue) > 0
        ? 'pending'
        : current.status
    ),
    createdAt: resolveDueDateFromBody(current.createdAt) || new Date().toISOString()
  };

  const normalized = normalizeClients(clients);
  writeJson(CLIENTS_FILE, { clients: normalized });
  const updated = normalized.find((item) => item.id === clients[index].id) || clients[index];

  return sendJson(res, 200, {
    ok: true,
    message: 'Costo actualizado para este proyecto',
    client: updated,
    clients: normalized
  });
}

async function handleClientsDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cliente requerido' });
  }

  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients);
  const filtered = clients.filter((item) => item.id !== id);

  if (filtered.length === clients.length) {
    return sendJson(res, 404, { ok: false, message: 'Cliente no encontrado' });
  }

  writeJson(CLIENTS_FILE, { clients: filtered });
  return sendJson(res, 200, { ok: true, message: 'Cliente eliminado', clients: filtered });
}

function handleClientProfilesGet(res) {
  const raw = readJson(CLIENT_PROFILES_FILE, defaultClientProfiles());
  const profiles = normalizeClientProfiles(raw.profiles);
  return sendJson(res, 200, { ok: true, profiles });
}

async function handleClientProfilesUpsert(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const name = sanitizeText(body.name || body.client || body.clientName, 80);
  const nit = sanitizeText(body.nit || body.clientNit, 60);
  const email = sanitizeText(body.email || body.clientEmail || body.collectionDebtorEmail, 120);
  const phone = sanitizeText(body.phone || body.clientPhone || body.collectionDebtorPhone, 60);
  const address = sanitizeText(body.address, 180);
  const notes = sanitizeText(body.notes, 300);

  if (!name) {
    return sendJson(res, 400, { ok: false, message: 'Nombre del cliente requerido' });
  }

  const raw = readJson(CLIENT_PROFILES_FILE, defaultClientProfiles());
  const profiles = normalizeClientProfiles(raw.profiles);
  const nameKey = normalizeClientProfileNameKey(name);
  let existingIndex = -1;

  if (id) {
    existingIndex = profiles.findIndex((item) => item.id === id);
  }
  if (existingIndex < 0 && nameKey) {
    existingIndex = profiles.findIndex((item) => normalizeClientProfileNameKey(item.name) === nameKey);
  }

  const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
  const now = new Date().toISOString();
  const next = {
    id: existing?.id || id || generateClientProfileId(),
    name,
    nit,
    email,
    phone,
    address,
    notes,
    createdAt: resolveDueDateFromBody(existing?.createdAt) || now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    profiles[existingIndex] = next;
  } else {
    profiles.push(next);
  }

  const normalized = normalizeClientProfiles(profiles);
  writeJson(CLIENT_PROFILES_FILE, { profiles: normalized });
  const persisted = normalized.find((item) => item.id === next.id) || next;

  return sendJson(res, 200, {
    ok: true,
    message: existingIndex >= 0
      ? 'Cliente del directorio actualizado'
      : 'Cliente guardado en directorio',
    profile: persisted,
    profiles: normalized
  });
}

async function handleClientProfilesDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cliente de directorio requerido' });
  }

  const raw = readJson(CLIENT_PROFILES_FILE, defaultClientProfiles());
  const profiles = normalizeClientProfiles(raw.profiles);
  const filtered = profiles.filter((item) => item.id !== id);

  if (filtered.length === profiles.length) {
    return sendJson(res, 404, { ok: false, message: 'Cliente del directorio no encontrado' });
  }

  writeJson(CLIENT_PROFILES_FILE, { profiles: filtered });
  return sendJson(res, 200, { ok: true, message: 'Cliente del directorio eliminado', profiles: filtered });
}

function handleQuotesGet(res) {
  const raw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(raw.quotes);
  return sendJson(res, 200, { ok: true, quotes });
}

async function handleQuotesCreate(req, res) {
  const body = await readBody(req);

  const id = sanitizeText(body.id, 40);
  const requestedSource = normalizeRecordSource(body.source, '');
  const requestedQuoteNumber = sanitizeText(body.quoteNumber, 60);
  const quoteDate = resolveDueDateFromBody(body.quoteDate) || new Date().toISOString();
  const companyName = sanitizeText(body.companyName, 80) || 'MOULE 3D';
  const companyNit = sanitizeText(body.companyNit, 60);
  const companyEmail = sanitizeText(body.companyEmail, 120);
  const companyPhone = sanitizeText(body.companyPhone, 60);
  const clientName = sanitizeText(body.clientName, 80);
  const clientNit = sanitizeText(body.clientNit, 60);
  const collectionDebtorEmail = sanitizeText(body.collectionDebtorEmail || body.debtorEmail, 120);
  const collectionDebtorPhone = sanitizeText(body.collectionDebtorPhone || body.debtorPhone, 60);
  const collectionDebtorAddress = sanitizeText(body.collectionDebtorAddress || body.debtorAddress, 180);
  const notes = sanitizeText(body.notes, 1200);
  const imageDataUrl = sanitizeImageDataUrl(body.imageDataUrl);
  const calculatorMeta = normalizeCalculatorMeta(body.calculatorMeta);
  const hasImageInBody = Object.prototype.hasOwnProperty.call(body, 'imageDataUrl');
  const hasCalculatorMetaInBody = Object.prototype.hasOwnProperty.call(body, 'calculatorMeta');
  const discount = parseMoney(body.discount);
  const items = normalizeQuoteItems(body.items);

  if (!clientName) {
    return sendJson(res, 400, { ok: false, message: 'Nombre de cliente requerido' });
  }

  if (items.length === 0) {
    return sendJson(res, 400, { ok: false, message: 'Debes agregar al menos un item' });
  }

  const totals = computeQuoteTotalsFromItems(items);
  const grossTotal = roundTwo(totals.subtotalDesign + totals.subtotalPrint);
  const netTotal = Math.max(0, roundTwo(grossTotal - discount));

  const raw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(raw.quotes);
  const existingIndex = id
    ? quotes.findIndex((item) => item.id === id)
    : -1;
  const existing = existingIndex >= 0 ? quotes[existingIndex] : null;

  if (existing && isQuoteDeletedRecord(existing)) {
    return sendJson(res, 409, { ok: false, message: 'El documento esta eliminado y no se puede editar' });
  }

  const source = existing
    ? normalizeRecordSource(existing?.source, inferQuoteSource(existing?.quoteNumber, existing?.notes))
    : (
      requestedSource
      || inferQuoteSource(requestedQuoteNumber, notes)
    );
  const hasSyncClientFlag = Object.prototype.hasOwnProperty.call(body, 'syncClient');
  const defaultSyncClient = source === 'calculadora'
    ? (Object.prototype.hasOwnProperty.call(existing || {}, 'syncClient') ? Boolean(existing?.syncClient) : true)
    : false;
  const syncClient = hasSyncClientFlag ? Boolean(body.syncClient) : defaultSyncClient;
  const now = new Date().toISOString();
  const approvedAtExisting = resolveDueDateFromBody(existing?.approvedAt);
  const approvedClientIdExisting = sanitizeText(existing?.approvedClientId, 40);
  const approvedTaskIdExisting = sanitizeText(existing?.approvedTaskId, 40);
  const serialKind = quoteSerialKindFromSource(source);
  let quoteNumber = sanitizeText(existing?.quoteNumber, 60);

  if (!quoteNumber) {
    if (serialKind) {
      quoteNumber = reserveNextQuoteSerialNumber(source, quotes);
    } else {
      quoteNumber = requestedQuoteNumber;
    }
  }

  if (!quoteNumber) {
    return sendJson(res, 400, { ok: false, message: 'No fue posible asignar numero de documento' });
  }

  const nextQuote = {
    id: existing?.id || id || generateQuoteId(),
    source,
    quoteNumber,
    quoteDate,
    companyName,
    companyNit,
    companyEmail,
    companyPhone,
    clientName,
    clientNit,
    collectionDebtorEmail,
    collectionDebtorPhone,
    collectionDebtorAddress,
    notes,
    imageDataUrl: hasImageInBody ? imageDataUrl : sanitizeImageDataUrl(existing?.imageDataUrl),
    calculatorMeta: hasCalculatorMetaInBody
      ? calculatorMeta
      : normalizeCalculatorMeta(existing?.calculatorMeta),
    syncClient,
    discount,
    items,
    subtotalDesign: totals.subtotalDesign,
    subtotalPrint: totals.subtotalPrint,
    grossTotal,
    netTotal,
    approvedAt: approvedAtExisting || '',
    approvedClientId: approvedClientIdExisting,
    approvedTaskId: approvedTaskIdExisting,
    deletedAt: '',
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    quotes[existingIndex] = nextQuote;
  } else {
    quotes.push(nextQuote);
  }

  writeJson(QUOTES_FILE, { quotes });
  let clientSyncResult = { synced: false, clients: null, message: '' };
  if (syncClient) {
    clientSyncResult = syncClientFromQuote(nextQuote);
  }

  const payload = {
    ok: true,
    message: existingIndex >= 0 ? 'Documento actualizado' : 'Documento guardado',
    quote: nextQuote,
    quotes,
    clientSynced: clientSyncResult.synced
  };

  if (clientSyncResult.message) {
    payload.clientMessage = clientSyncResult.message;
  }
  if (Array.isArray(clientSyncResult.clients)) {
    payload.clients = clientSyncResult.clients;
  }

  return sendJson(res, 200, payload);
}

async function handleQuotesDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cotizacion requerido' });
  }

  const raw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(raw.quotes);
  const index = quotes.findIndex((item) => item.id === id);
  if (index < 0) {
    return sendJson(res, 404, { ok: false, message: 'Cotizacion no encontrada' });
  }

  const current = quotes[index];
  if (isQuoteDeletedRecord(current)) {
    return sendJson(res, 200, {
      ok: true,
      message: 'Documento ya estaba marcado como eliminado',
      quotes
    });
  }

  const now = new Date().toISOString();
  quotes[index] = {
    ...current,
    deletedAt: now,
    updatedAt: now
  };

  const normalizedQuotes = normalizeQuotes(quotes);
  writeJson(QUOTES_FILE, { quotes: normalizedQuotes });
  return sendJson(res, 200, {
    ok: true,
    message: 'Documento marcado como eliminado',
    quotes: normalizedQuotes
  });
}

async function handleQuotesApprove(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const requestedDeliveryDueAt = resolveDueDateFromBody(body.deliveryDueAt || body.dueAt);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cotizacion requerido para aprobar' });
  }

  const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(quotesRaw.quotes);
  const quoteIndex = quotes.findIndex((item) => item.id === id);

  if (quoteIndex < 0) {
    return sendJson(res, 404, { ok: false, message: 'Cotizacion no encontrada' });
  }

  const quote = quotes[quoteIndex];
  if (isQuoteDeletedRecord(quote)) {
    return sendJson(res, 409, { ok: false, message: 'El documento esta eliminado y no se puede aprobar' });
  }
  const source = normalizeRecordSource(quote.source, inferQuoteSource(quote.quoteNumber, quote.notes));
  if (source === 'cuenta_cobro') {
    return sendJson(res, 409, {
      ok: false,
      message: 'Las cuentas de cobro no se aprueban como cotizacion'
    });
  }

  const approvalSource = source === 'calculadora' ? 'calculadora' : 'cotizacion';
  const quoteId = sanitizeText(quote.id, 40);
  const quoteRef = sanitizeText(quote.quoteNumber, 60);
  if (!quoteRef) {
    return sendJson(res, 409, { ok: false, message: 'Referencia de cotizacion invalida' });
  }

  const now = new Date().toISOString();
  const dueAtBase = resolveDueDateFromBody(quote.quoteDate) || now;
  const dueAt = requestedDeliveryDueAt || addHoursToIso(dueAtBase, 72);
  const calculatorMeta = normalizeCalculatorMeta(quote.calculatorMeta);
  const quotedValue = parseMoney(quote.netTotal);
  const saleValue = parseMoney(quote.netTotal);
  const calculatorElectricityCost = approvalSource === 'calculadora'
    ? parseMoney(calculatorMeta?.electricityCost)
    : 0;
  const calculatorOperatorPay = approvalSource === 'calculadora'
    ? parseMoney(calculatorMeta?.operatorPay)
    : 0;
  const calculatorMaterialCost = approvalSource === 'calculadora'
    ? parseMoney(calculatorMeta?.materialCost)
    : 0;
  const costValue = approvalSource === 'calculadora'
    ? parseMoney(
      calculatorMeta?.totalCost
      || quote.grossTotal
      || (calculatorElectricityCost + calculatorOperatorPay + calculatorMaterialCost)
    )
    : 0;
  const clientName = sanitizeText(quote.clientName, 80) || 'Sin cliente';
  const product = buildQuoteProductSummary(quote);
  const machine = sanitizeText(calculatorMeta?.machineLabel, 60) || 'Impresion 3D';

  const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(clientsRaw.clients);
  const quoteIdLower = quoteId.toLowerCase();
  const quoteRefLower = quoteRef.toLowerCase();
  const preferredClientId = sanitizeText(quote.approvedClientId, 40);
  let existingClientIndex = -1;
  if (preferredClientId) {
    existingClientIndex = clients.findIndex((item) => item.id === preferredClientId);
  }
  if (existingClientIndex < 0 && quoteIdLower) {
    existingClientIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    );
  }
  if (existingClientIndex < 0) {
    existingClientIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource
        && (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        )
        && String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    );
  }

  let clientCreated = false;
  let clientId = '';

  if (existingClientIndex >= 0) {
    const current = clients[existingClientIndex];
    const currentStatus = normalizeStatus(current.status);
    const nextStatus = (currentStatus === 'quoted' || currentStatus === 'cancelled')
      ? 'pending'
      : currentStatus;

    clients[existingClientIndex] = {
      ...current,
      client: clientName,
      product,
      machine,
      source: approvalSource,
      quoteId,
      quoteRef,
      status: nextStatus,
      quotedValue,
      saleValue,
      costValue: approvalSource === 'calculadora' ? costValue : parseMoney(current.costValue),
      electricityCost: approvalSource === 'calculadora'
        ? calculatorElectricityCost
        : parseMoney(current.electricityCost),
      operatorPay: approvalSource === 'calculadora'
        ? calculatorOperatorPay
        : parseMoney(current.operatorPay),
      materialCost: approvalSource === 'calculadora'
        ? calculatorMaterialCost
        : parseMoney(current.materialCost),
      dueAt: requestedDeliveryDueAt || resolveDueDateFromBody(current.dueAt) || dueAt,
      createdAt: resolveDueDateFromBody(current.createdAt) || now
    };
    clientId = clients[existingClientIndex].id;
  } else {
    clientCreated = true;
    const newClient = {
      id: generateClientId(),
      client: clientName,
      product,
      machine,
      source: approvalSource,
      quoteId,
      quoteRef,
      status: 'pending',
      quotedValue,
      saleValue,
      costValue,
      electricityCost: approvalSource === 'calculadora' ? calculatorElectricityCost : 0,
      operatorPay: approvalSource === 'calculadora' ? calculatorOperatorPay : 0,
      materialCost: approvalSource === 'calculadora' ? calculatorMaterialCost : 0,
      dueAt,
      createdAt: now
    };
    clients.push(newClient);
    clientId = newClient.id;
  }

  const normalizedClients = normalizeClients(clients);
  writeJson(CLIENTS_FILE, { clients: normalizedClients });
  const persistedClient = normalizedClients.find((item) => item.id === clientId)
    || normalizedClients.find(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    )
    || normalizedClients.find(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource &&
        (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) &&
        String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    )
    || null;
  if (persistedClient) {
    clientId = persistedClient.id;
  }

  const tasksRaw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(tasksRaw.tasks);
  const preferredTaskId = sanitizeText(quote.approvedTaskId, 40);
  let existingTaskIndex = -1;
  if (preferredTaskId) {
    existingTaskIndex = tasks.findIndex((item) => item.id === preferredTaskId);
  }
  if (existingTaskIndex < 0 && quoteIdLower) {
    existingTaskIndex = tasks.findIndex(
      (item) =>
        item.kind === 'impresion'
        && normalizeTaskSource(item.source) === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    );
  }
  if (existingTaskIndex < 0) {
    existingTaskIndex = tasks.findIndex(
      (item) =>
        item.kind === 'impresion'
        && normalizeTaskSource(item.source) === approvalSource
        && (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        )
        && String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    );
  }

  const taskTitle = buildQuotePrintTaskTitle(quote);
  const taskNotes = `Generada al aprobar cotizacion ${quoteRef}.`;
  const taskDetails = buildQuotePrintTaskDetails(quote);
  let taskCreated = false;
  let taskId = '';

  if (existingTaskIndex >= 0) {
    const current = tasks[existingTaskIndex];
    tasks[existingTaskIndex] = {
      ...current,
      kind: 'impresion',
      source: approvalSource,
      quoteId,
      quoteRef,
      client: clientName,
      title: taskTitle,
      notes: taskNotes,
      details: taskDetails,
      dueAt: requestedDeliveryDueAt || resolveDueDateFromBody(current.dueAt) || dueAt,
      status: normalizeTaskStatus(current.status),
      createdAt: resolveDueDateFromBody(current.createdAt) || now
    };
    taskId = tasks[existingTaskIndex].id;
  } else {
    taskCreated = true;
    const newTask = {
      id: generateTaskId(),
      kind: 'impresion',
      source: approvalSource,
      quoteId,
      quoteRef,
      client: clientName,
      title: taskTitle,
      notes: taskNotes,
      details: taskDetails,
      dueAt,
      status: 'pending',
      createdAt: now
    };
    tasks.push(newTask);
    taskId = newTask.id;
  }

  const normalizedTasks = normalizeTasks(tasks);
  writeJson(TASKS_FILE, { tasks: normalizedTasks });
  const persistedTask = normalizedTasks.find((item) => item.id === taskId)
    || normalizedTasks.find(
      (item) =>
        item.kind === 'impresion'
        && normalizeTaskSource(item.source) === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    )
    || normalizedTasks.find(
      (item) =>
        item.kind === 'impresion' &&
        normalizeTaskSource(item.source) === approvalSource &&
        (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) &&
        String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    )
    || null;
  if (persistedTask) {
    taskId = persistedTask.id;
  }

  const alreadyApproved = Boolean(resolveDueDateFromBody(quote.approvedAt));
  const nextQuote = {
    ...quote,
    source: approvalSource,
    approvedAt: now,
    approvedClientId: clientId,
    approvedTaskId: taskId,
    updatedAt: now
  };
  quotes[quoteIndex] = nextQuote;
  const normalizedQuotes = normalizeQuotes(quotes);
  writeJson(QUOTES_FILE, { quotes: normalizedQuotes });
  const persistedQuote = normalizedQuotes.find((item) => item.id === nextQuote.id) || nextQuote;

  const syncPieces = [
    clientCreated ? 'ingreso creado' : 'ingreso actualizado',
    taskCreated ? 'tarea de impresion creada' : 'tarea de impresion actualizada'
  ];
  const message = alreadyApproved
    ? `Cotizacion ya aprobada; ${syncPieces.join(' y ')}.`
    : `Cotizacion aprobada; ${syncPieces.join(' y ')}.`;

  return sendJson(res, 200, {
    ok: true,
    message,
    quote: persistedQuote,
    quotes: normalizedQuotes,
    clients: normalizedClients,
    tasks: normalizedTasks,
    alreadyApproved,
    clientCreated,
    taskCreated
  });
}

async function handleQuotesUnapprove(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de cotizacion requerido para desaprobar' });
  }

  const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(quotesRaw.quotes);
  const quoteIndex = quotes.findIndex((item) => item.id === id);

  if (quoteIndex < 0) {
    return sendJson(res, 404, { ok: false, message: 'Cotizacion no encontrada' });
  }

  const quote = quotes[quoteIndex];
  if (isQuoteDeletedRecord(quote)) {
    return sendJson(res, 409, { ok: false, message: 'El documento esta eliminado y no se puede desaprobar' });
  }
  const source = normalizeRecordSource(quote.source, inferQuoteSource(quote.quoteNumber, quote.notes));
  if (source === 'cuenta_cobro') {
    return sendJson(res, 409, {
      ok: false,
      message: 'La cuenta de cobro no usa aprobacion/desaprobacion de cotizacion'
    });
  }

  const approvalSource = source === 'calculadora' ? 'calculadora' : 'cotizacion';
  const quoteId = sanitizeText(quote.id, 40);
  const quoteRef = sanitizeText(quote.quoteNumber, 60);
  if (!quoteRef) {
    return sendJson(res, 409, { ok: false, message: 'Referencia de cotizacion invalida' });
  }

  const now = new Date().toISOString();
  const quoteIdLower = quoteId.toLowerCase();
  const quoteRefLower = quoteRef.toLowerCase();
  const preferredClientId = sanitizeText(quote.approvedClientId, 40);
  const preferredTaskId = sanitizeText(quote.approvedTaskId, 40);

  const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(clientsRaw.clients);
  let clientTouched = false;
  let clientRemoved = false;
  let clientReverted = false;
  let clientIndex = -1;

  if (preferredClientId) {
    clientIndex = clients.findIndex((item) => item.id === preferredClientId);
  }
  if (clientIndex < 0 && quoteIdLower) {
    clientIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        && (Number(item.saleValue || 0) > 0 || normalizeStatus(item.status) !== 'quoted')
    );
  }
  if (clientIndex < 0) {
    clientIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === approvalSource &&
        (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) &&
        String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower &&
        (Number(item.saleValue || 0) > 0 || normalizeStatus(item.status) !== 'quoted')
    );
  }

  if (clientIndex >= 0) {
    clientTouched = true;
    if (approvalSource === 'calculadora') {
      const current = clients[clientIndex];
      const dueAtBase = resolveDueDateFromBody(quote.quoteDate) || now;
      clients[clientIndex] = {
        ...current,
        source: 'calculadora',
        quoteId,
        quoteRef,
        status: 'quoted',
        quotedValue: parseMoney(quote.netTotal),
        saleValue: 0,
        dueAt: resolveDueDateFromBody(current.dueAt) || addHoursToIso(dueAtBase, 72),
        createdAt: resolveDueDateFromBody(current.createdAt) || now
      };
      clientReverted = true;
    } else {
      clients.splice(clientIndex, 1);
      clientRemoved = true;
    }
  }

  const normalizedClients = normalizeClients(clients);
  if (clientTouched) {
    writeJson(CLIENTS_FILE, { clients: normalizedClients });
  }

  const tasksRaw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(tasksRaw.tasks);
  let taskRemoved = false;
  let taskIndex = -1;

  if (preferredTaskId) {
    taskIndex = tasks.findIndex((item) => item.id === preferredTaskId);
  }
  if (taskIndex < 0 && quoteIdLower) {
    taskIndex = tasks.findIndex(
      (item) =>
        item.kind === 'impresion'
        && normalizeTaskSource(item.source) === approvalSource
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    );
  }
  if (taskIndex < 0) {
    taskIndex = tasks.findIndex(
      (item) =>
        item.kind === 'impresion' &&
        normalizeTaskSource(item.source) === approvalSource &&
        (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) &&
        String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    );
  }

  if (taskIndex >= 0) {
    tasks.splice(taskIndex, 1);
    taskRemoved = true;
  }

  const normalizedTasks = normalizeTasks(tasks);
  if (taskRemoved) {
    writeJson(TASKS_FILE, { tasks: normalizedTasks });
  }

  const hadApprovalMark = Boolean(resolveDueDateFromBody(quote.approvedAt))
    || Boolean(preferredClientId)
    || Boolean(preferredTaskId);

  if (!hadApprovalMark && !clientTouched && !taskRemoved) {
    return sendJson(res, 409, {
      ok: false,
      message: 'La cotizacion ya estaba desaprobada',
      quote,
      quotes,
      clients: normalizedClients,
      tasks: normalizedTasks
    });
  }

  const nextQuote = {
    ...quote,
    approvedAt: '',
    approvedClientId: '',
    approvedTaskId: '',
    updatedAt: now
  };
  quotes[quoteIndex] = nextQuote;
  const normalizedQuotes = normalizeQuotes(quotes);
  writeJson(QUOTES_FILE, { quotes: normalizedQuotes });
  const persistedQuote = normalizedQuotes.find((item) => item.id === nextQuote.id) || nextQuote;

  const messageParts = [];
  if (clientRemoved) {
    messageParts.push('ingreso eliminado');
  }
  if (clientReverted) {
    messageParts.push('ingreso revertido a cotizado');
  }
  if (taskRemoved) {
    messageParts.push('tarea de impresion eliminada');
  }
  if (messageParts.length === 0) {
    messageParts.push('sin cambios adicionales');
  }

  return sendJson(res, 200, {
    ok: true,
    message: `Cotizacion desaprobada; ${messageParts.join(' y ')}.`,
    quote: persistedQuote,
    quotes: normalizedQuotes,
    clients: normalizedClients,
    tasks: normalizedTasks,
    clientRemoved,
    clientReverted,
    taskRemoved
  });
}

function buildQuoteProductSummary(quote) {
  const items = normalizeQuoteItems(quote?.items);
  if (items.length === 0) {
    return 'Trabajo aprobado desde cotizacion';
  }

  const top = items.slice(0, 3).map((item) => {
    const quantity = Math.max(1, parseCount(item.quantity || 1));
    const concept = sanitizeText(item.concept, 80) || 'Sin concepto';
    return `${quantity}x ${concept}`;
  });

  if (items.length > 3) {
    top.push(`+${items.length - 3} items`);
  }

  return sanitizeText(top.join(' / '), 120) || 'Trabajo aprobado desde cotizacion';
}

function buildQuotePrintTaskTitle(quote) {
  const quoteRef = sanitizeText(quote?.quoteNumber, 60) || 'SIN-REF';
  const product = buildQuoteProductSummary(quote);
  return sanitizeText(`Impresion 3D ${quoteRef} - ${product}`, 220) || `Impresion 3D ${quoteRef}`;
}

function buildQuotePrintTaskDetails(quote) {
  const quoteRef = sanitizeText(quote?.quoteNumber, 60) || 'Sin numero';
  const items = normalizeQuoteItems(quote?.items);
  const lines = [
    `Cotizacion aprobada: ${quoteRef}`,
    `Cliente: ${sanitizeText(quote?.clientName, 80) || 'Sin cliente'}`,
    `Fecha de cotizacion: ${formatQuoteApprovalDate(quote?.quoteDate)}`,
    `Subtotal diseno: ${formatCopMoney(quote?.subtotalDesign || 0)}`,
    `Subtotal impresion: ${formatCopMoney(quote?.subtotalPrint || 0)}`,
    `Total aprobado: ${formatCopMoney(quote?.netTotal || 0)}`,
    'Detalle de piezas:'
  ];

  if (items.length === 0) {
    lines.push('1. Sin detalle de items.');
  } else {
    items.forEach((item, index) => {
      lines.push(
        `${index + 1}. Cantidad: ${item.quantity} | Concepto: ${item.concept || 'Sin concepto'} | Diseno: ${formatCopMoney(item.designValue)} | Impresion: ${formatCopMoney(item.printValue)} | Total: ${formatCopMoney(item.rowTotal)}`
      );
    });
  }

  const notes = sanitizeText(quote?.notes, 600);
  if (notes) {
    lines.push(`Observaciones: ${notes}`);
  }

  return sanitizeMultilineText(lines.join('\n'), 2400);
}

function formatQuoteApprovalDate(value) {
  const iso = resolveDueDateFromBody(value);
  if (!iso) {
    return '-';
  }
  return new Date(iso).toLocaleString('es-CO');
}

function formatCopMoney(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(parseMoney(value));
}

function handleCalculatorHistoryGet(res) {
  const raw = readJson(CALCULATOR_HISTORY_FILE, defaultCalculatorHistory());
  const entries = normalizeCalculatorHistory(raw.entries);
  return sendJson(res, 200, { ok: true, entries });
}

async function handleCalculatorHistoryUpsert(req, res) {
  const body = await readBody(req);
  const now = new Date().toISOString();
  const raw = readJson(CALCULATOR_HISTORY_FILE, defaultCalculatorHistory());
  const entries = normalizeCalculatorHistory(raw.entries);
  const id = sanitizeText(body.id, 40);
  const status = normalizeCalculatorHistoryStatus(body.status);
  const mode = normalizeCalculatorMode(body.mode);
  const baseCreatedAt = resolveDueDateFromBody(body.createdAt) || now;
  const quoteNumber = sanitizeText(body.quoteNumber, 60);
  const quoteId = sanitizeText(body.quoteId, 40);

  const payload = {
    id: id || generateCalculatorHistoryId(),
    clientName: sanitizeText(body.clientName, 80) || 'Sin cliente',
    mode,
    modeLabel: sanitizeText(body.modeLabel, 40) || calculatorModeLabelFromKey(mode),
    status,
    machineLabel: sanitizeText(body.machineLabel, 60),
    materialLabel: sanitizeText(body.materialLabel, 60),
    colorLabel: sanitizeText(body.colorLabel, 60),
    timeHours: parseNonNegativeFloat(body.timeHours),
    materialGrams: parseNonNegativeFloat(body.materialGrams),
    electricityCost: parseMoney(body.electricityCost),
    operatorPay: parseMoney(body.operatorPay),
    materialCost: parseMoney(body.materialCost),
    costPiece: parseMoney(body.costPiece),
    commercialValue: parseMoney(body.commercialValue),
    finalValue: parseMoney(body.finalValue),
    exchangeRate: parseNonNegativeFloat(body.exchangeRate),
    breakdown: sanitizeText(body.breakdown, 360),
    stockProcess: normalizeCalculatorStockProcess(body.stockProcess),
    stockMaterial: sanitizeText(body.stockMaterial, 40).toLowerCase(),
    stockColor: sanitizeText(body.stockColor, 40),
    stockGrams: parseNonNegativeFloat(body.stockGrams),
    quoteNumber,
    quoteId,
    inputSnapshot: normalizeCalculatorInputSnapshot(body.inputSnapshot),
    createdAt: baseCreatedAt,
    updatedAt: now
  };

  const index = entries.findIndex((item) => item.id === payload.id);
  let message = 'Registro de calculadora guardado';
  if (index >= 0) {
    payload.createdAt = entries[index].createdAt;
    entries[index] = payload;
    message = 'Registro de calculadora actualizado';
  } else {
    entries.push(payload);
  }

  const normalized = normalizeCalculatorHistory(entries).slice(0, 500);
  writeJson(CALCULATOR_HISTORY_FILE, { entries: normalized });
  const persisted = normalized.find((item) => item.id === payload.id) || normalized[0] || null;

  return sendJson(res, 200, {
    ok: true,
    message,
    entry: persisted,
    entries: normalized
  });
}

async function handleCalculatorHistoryDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de historial requerido' });
  }

  const raw = readJson(CALCULATOR_HISTORY_FILE, defaultCalculatorHistory());
  const entries = normalizeCalculatorHistory(raw.entries);
  const filtered = entries.filter((item) => item.id !== id);

  if (filtered.length === entries.length) {
    return sendJson(res, 404, { ok: false, message: 'Registro de historial no encontrado' });
  }

  writeJson(CALCULATOR_HISTORY_FILE, { entries: filtered });
  return sendJson(res, 200, {
    ok: true,
    message: 'Registro de historial eliminado',
    entries: filtered
  });
}

function handleTasksGet(res) {
  const raw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(raw.tasks);
  return sendJson(res, 200, { ok: true, tasks });
}

async function handleTasksCreate(req, res) {
  const body = await readBody(req);

  const kind = normalizeTaskKind(body.kind);
  const source = normalizeTaskSource(body.source);
  const quoteId = sanitizeText(body.quoteId, 40);
  const quoteRef = sanitizeText(body.quoteRef, 80);
  const client = sanitizeText(body.client, 80);
  const title = sanitizeText(body.title, 220);
  const notes = sanitizeText(body.notes, 400);
  const details = sanitizeMultilineText(body.details, 2400);
  const dueAt = resolveDueDateFromBody(body.dueAt) || '';
  const status = normalizeTaskStatus(body.status || 'pending');

  if (!title) {
    return sendJson(res, 400, { ok: false, message: 'Titulo de tarea requerido' });
  }

  const raw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(raw.tasks);

  tasks.push({
    id: generateTaskId(),
    kind,
    source,
    quoteId,
    quoteRef,
    client,
    title,
    notes,
    details,
    dueAt,
    status,
    createdAt: new Date().toISOString()
  });

  writeJson(TASKS_FILE, { tasks });
  return sendJson(res, 200, { ok: true, message: 'Tarea creada', tasks });
}

async function handleTasksStatus(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const status = normalizeTaskStatus(body.status);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de tarea requerido' });
  }

  const raw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(raw.tasks);
  const index = tasks.findIndex((item) => item.id === id);

  if (index < 0) {
    return sendJson(res, 404, { ok: false, message: 'Tarea no encontrada' });
  }

  tasks[index].status = status;
  const normalizedTasks = normalizeTasks(tasks);
  writeJson(TASKS_FILE, { tasks: normalizedTasks });
  return sendJson(res, 200, { ok: true, message: 'Estado de tarea actualizado', tasks: normalizedTasks });
}

async function handleTasksDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de tarea requerido' });
  }

  const raw = readJson(TASKS_FILE, defaultTasks());
  const tasks = normalizeTasks(raw.tasks);
  const filtered = tasks.filter((item) => item.id !== id);

  if (filtered.length === tasks.length) {
    return sendJson(res, 404, { ok: false, message: 'Tarea no encontrada' });
  }

  writeJson(TASKS_FILE, { tasks: filtered });
  return sendJson(res, 200, { ok: true, message: 'Tarea eliminada', tasks: filtered });
}

// ── STL File Management ─────────────────────────────────────────────────────

function readBodyBuffer(req, maxSize = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxSize) {
        done = true;
        req.destroy();
        reject(new Error('Archivo demasiado grande (max 100 MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!done) { done = true; reject(err); }
    });
  });
}

function bufIndexOf(haystack, needle, start) {
  const s = start || 0;
  outer: for (let i = s; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseMultipartFile(buf, boundary) {
  const delim = Buffer.from(`--${boundary}\r\n`);
  const end = Buffer.from(`--${boundary}--`);
  const crlf2 = Buffer.from('\r\n\r\n');
  const nextBound = Buffer.from(`\r\n--${boundary}`);

  const result = { filename: '', content: null, designName: '', client: '', notes: '', taskId: '' };
  let pos = 0;

  while (pos < buf.length) {
    const delimPos = bufIndexOf(buf, delim, pos);
    if (delimPos < 0) break;
    pos = delimPos + delim.length;

    const headerEnd = bufIndexOf(buf, crlf2, pos);
    if (headerEnd < 0) break;
    const headersStr = buf.slice(pos, headerEnd).toString('utf-8');
    pos = headerEnd + 4;

    const contentEnd = bufIndexOf(buf, nextBound, pos);
    if (contentEnd < 0) break;
    const partContent = buf.slice(pos, contentEnd);
    pos = contentEnd;

    let fieldName = '';
    let filename = '';
    for (const line of headersStr.split('\r\n')) {
      const mFile = line.match(/content-disposition\s*:.*filename="([^"]+)"/i);
      if (mFile) { filename = mFile[1]; }
      const mName = line.match(/content-disposition\s*:.*name="([^"]+)"/i);
      if (mName) { fieldName = mName[1]; }
    }

    if (filename) {
      result.filename = filename;
      result.content = partContent;
    } else if (fieldName === 'designName') {
      result.designName = partContent.toString('utf-8').trim();
    } else if (fieldName === 'client') {
      result.client = partContent.toString('utf-8').trim();
    } else if (fieldName === 'notes') {
      result.notes = partContent.toString('utf-8').trim();
    } else if (fieldName === 'taskId') {
      result.taskId = partContent.toString('utf-8').trim();
    }
  }

  if (!result.content) return null;
  return result;
}

function sanitizeStlFilename(raw) {
  let name = String(raw || '').replace(/[\\/\0]/g, '').replace(/[*?:<>|"]/g, '_').trim();
  if (!name.toLowerCase().endsWith('.stl')) return null;
  if (name.length > 200) name = name.slice(0, 196) + '.stl';
  return name || null;
}

async function handleStlUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) {
    return sendJson(res, 400, { ok: false, message: 'Content-Type multipart/form-data requerido' });
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');

  let buf;
  try {
    buf = await readBodyBuffer(req);
  } catch (err) {
    return sendJson(res, 413, { ok: false, message: err.message || 'Error leyendo archivo' });
  }

  const parsed = parseMultipartFile(buf, boundary);
  if (!parsed || !parsed.content.length) {
    return sendJson(res, 400, { ok: false, message: 'No se encontro archivo en la solicitud' });
  }

  const safeName = sanitizeStlFilename(parsed.filename);
  if (!safeName) {
    return sendJson(res, 400, { ok: false, message: 'Solo se permiten archivos .stl' });
  }

  // Avoid overwriting: add timestamp suffix if file already exists
  let destName = safeName;
  const destBase = safeName.slice(0, safeName.length - 4);
  let destPath = path.join(STL_DIR, destName);
  if (fs.existsSync(destPath)) {
    const stamp = Date.now();
    destName = `${destBase}_${stamp}.stl`;
    destPath = path.join(STL_DIR, destName);
  }

  try {
    fs.writeFileSync(destPath, parsed.content);
  } catch (err) {
    console.error('[STL upload] Error escribiendo archivo:', err.message);
    return sendJson(res, 500, { ok: false, message: 'Error guardando el archivo' });
  }

  // Save optional metadata if provided in multipart fields
  const designName = (parsed.designName || '').slice(0, 160);
  const client = (parsed.client || '').slice(0, 80);
  const notes = (parsed.notes || '').slice(0, 300);
  const taskId = (parsed.taskId || '').slice(0, 80);
  if (designName || client || notes || taskId) {
    const meta = readStlMeta();
    meta[destName] = { designName, client, notes, taskId, updatedAt: new Date().toISOString() };
    writeStlMeta(meta);
  }

  return sendJson(res, 200, {
    ok: true,
    message: `Archivo guardado: ${destName}`,
    file: { name: destName, size: parsed.content.length, savedAt: new Date().toISOString() }
  });
}

function readStlMeta() {
  try {
    return JSON.parse(fs.readFileSync(STL_META_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStlMeta(meta) {
  fs.writeFileSync(STL_META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

function handleStlFiles(_req, res, url) {
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  const clientFilter = (url.searchParams.get('client') || '').trim().toLowerCase();
  const taskIdFilter = (url.searchParams.get('taskId') || '').trim();
  let entries;
  try {
    entries = fs.readdirSync(STL_DIR, { withFileTypes: true });
  } catch {
    return sendJson(res, 200, { ok: true, files: [] });
  }

  const meta = readStlMeta();

  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.stl'))
    .map((e) => {
      try {
        const stat = fs.statSync(path.join(STL_DIR, e.name));
        const m = meta[e.name] || {};
        return {
          name: e.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          designName: m.designName || '',
          client: m.client || '',
          notes: m.notes || '',
          taskId: m.taskId || ''
        };
      } catch {
        return { name: e.name, size: 0, modifiedAt: '', designName: '', client: '', notes: '', taskId: '' };
      }
    })
    .filter((f) => {
      if (taskIdFilter && f.taskId !== taskIdFilter) return false;
      if (query && !f.name.toLowerCase().includes(query) && !f.designName.toLowerCase().includes(query) && !f.client.toLowerCase().includes(query)) return false;
      if (clientFilter && !f.client.toLowerCase().includes(clientFilter)) return false;
      return true;
    })
    .sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));

  return sendJson(res, 200, { ok: true, files, directory: STL_DIR });
}

function handleStlServe(_req, res, url) {
  const name = (url.searchParams.get('name') || '').replace(/[\\/\0]/g, '').trim();
  if (!name || !name.toLowerCase().endsWith('.stl')) {
    return sendJson(res, 400, { ok: false, message: 'Nombre de archivo invalido' });
  }
  const filePath = path.join(STL_DIR, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(STL_DIR))) {
    return sendJson(res, 403, { ok: false, message: 'Acceso denegado' });
  }
  if (!fs.existsSync(resolved)) {
    return sendJson(res, 404, { ok: false, message: 'Archivo no encontrado' });
  }
  const stat = fs.statSync(resolved);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${name}"`,
    'Cache-Control': 'private, max-age=3600'
  });
  fs.createReadStream(resolved).pipe(res);
}

async function handleStlMetaSave(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, message: 'Error leyendo datos' });
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, message: 'JSON invalido' });
  }
  const name = (String(data.name || '')).replace(/[\\/\0]/g, '').trim();
  if (!name || !name.toLowerCase().endsWith('.stl')) {
    return sendJson(res, 400, { ok: false, message: 'Nombre de archivo invalido' });
  }
  const filePath = path.join(STL_DIR, name);
  if (!fs.existsSync(filePath)) {
    return sendJson(res, 404, { ok: false, message: 'Archivo no encontrado' });
  }
  const meta = readStlMeta();
  meta[name] = {
    designName: String(data.designName || '').slice(0, 160),
    client: String(data.client || '').slice(0, 80),
    notes: String(data.notes || '').slice(0, 300),
    taskId: String(data.taskId || '').slice(0, 80),
    updatedAt: new Date().toISOString()
  };
  writeStlMeta(meta);
  return sendJson(res, 200, { ok: true });
}

async function handleStlDelete(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, message: 'Error leyendo datos' });
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, message: 'JSON invalido' });
  }
  const name = (String(data.name || '')).replace(/[\\/\0]/g, '').trim();
  if (!name || !name.toLowerCase().endsWith('.stl')) {
    return sendJson(res, 400, { ok: false, message: 'Nombre de archivo invalido' });
  }
  const filePath = path.join(STL_DIR, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(STL_DIR))) {
    return sendJson(res, 403, { ok: false, message: 'Acceso denegado' });
  }
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (err) {
    return sendJson(res, 500, { ok: false, message: 'Error eliminando archivo: ' + err.message });
  }
  // Remove metadata entry
  const meta = readStlMeta();
  delete meta[name];
  writeStlMeta(meta);
  return sendJson(res, 200, { ok: true, message: 'Archivo eliminado' });
}

// ── End STL ──────────────────────────────────────────────────────────────────

function handlePrintersGet(res) {
  const raw = readJson(PRINTERS_FILE, defaultPrinters());
  const printers = normalizePrinters(raw.printers);
  return sendJson(res, 200, { ok: true, printers });
}

async function handlePrintersUpdate(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);
  const status = normalizePrinterStatus(body.status);
  const material = sanitizeText(body.material, 80);
  const currentJob = sanitizeText(body.currentJob, 160);
  const currentTaskId = sanitizeText(body.currentTaskId, 40);
  const notes = sanitizeText(body.notes, 180);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de impresora requerido' });
  }

  const raw = readJson(PRINTERS_FILE, defaultPrinters());
  const printers = normalizePrinters(raw.printers);
  const index = printers.findIndex((item) => item.id === id);

  if (index < 0) {
    return sendJson(res, 404, { ok: false, message: 'Impresora no encontrada' });
  }

  printers[index].status = status;
  printers[index].material = material;
  printers[index].currentJob = currentJob;
  printers[index].currentTaskId = currentTaskId;
  printers[index].notes = notes;
  printers[index].updatedAt = new Date().toISOString();

  writeJson(PRINTERS_FILE, { printers });
  return sendJson(res, 200, { ok: true, message: 'Impresora actualizada', printers });
}

function handleAccountsGet(res) {
  const raw = readJson(ACCOUNTS_FILE, defaultAccounts());
  const accounts = normalizeAccountsState(raw);
  const payables = buildAccountsPayablesView(accounts);
  const approvedCalculatorPrints = buildApprovedCalculatorPrintEntries();
  return sendJson(res, 200, {
    ok: true,
    entries: accounts.entries,
    payables,
    approvedCalculatorPrints,
    summary: buildAccountsSummaryFromPayables(accounts, payables)
  });
}

async function handleAccountsEntryUpsert(req, res) {
  const body = await readBody(req);
  const now = new Date().toISOString();
  const raw = readJson(ACCOUNTS_FILE, defaultAccounts());
  const accounts = normalizeAccountsState(raw);
  const entries = normalizeAccountEntries(accounts.entries);

  const id = sanitizeText(body.id, 40);
  const type = normalizeAccountEntryType(body.type || body.kind);
  const account = sanitizeText(body.account || body.accountName || body.cuenta, 80);
  const description = sanitizeText(
    body.description || body.notes || body.concept || body.detalle,
    260
  );
  const amount = parseMoney(body.amount ?? body.value ?? body.valor);
  const date = resolveDueDateFromBody(body.date || body.movedAt || body.fecha) || now;
  const attachmentDataUrl = sanitizeAccountAttachmentDataUrl(
    body.attachmentDataUrl || body.attachment || body.proofImageDataUrl || body.adjunto
  );
  const attachmentName = sanitizeText(
    body.attachmentName || body.attachmentFileName || body.attachmentLabel || body.adjuntoNombre,
    120
  );

  if (amount <= 0) {
    return sendJson(res, 400, { ok: false, message: 'El valor del movimiento debe ser mayor a cero' });
  }

  if (!account && !description) {
    return sendJson(res, 400, { ok: false, message: 'Debes indicar cuenta o detalle del movimiento' });
  }

  const payload = {
    id: id || generateAccountEntryId(),
    type,
    date,
    account,
    description,
    amount,
    attachmentDataUrl,
    attachmentName,
    createdAt: now,
    updatedAt: now
  };

  let message = 'Movimiento guardado';
  const index = entries.findIndex((item) => item.id === payload.id);
  if (index >= 0) {
    const current = entries[index];
    entries[index] = {
      ...current,
      ...payload,
      createdAt: current.createdAt || now,
      attachmentDataUrl: attachmentDataUrl || current.attachmentDataUrl,
      attachmentName: attachmentName || current.attachmentName
    };
    message = 'Movimiento actualizado';
  } else {
    entries.push(payload);
  }

  const normalizedEntries = normalizeAccountEntries(entries);
  const nextState = {
    entries: normalizedEntries,
    payables: normalizeAccountsPayables(accounts.payables)
  };
  writeJson(ACCOUNTS_FILE, nextState);

  return sendJson(res, 200, {
    ok: true,
    message,
    entry: normalizedEntries.find((item) => item.id === payload.id) || null,
    entries: normalizedEntries,
    payables: buildAccountsPayablesView(nextState),
    approvedCalculatorPrints: buildApprovedCalculatorPrintEntries(),
    summary: buildAccountsSummary(nextState)
  });
}

async function handleAccountsEntryDelete(req, res) {
  const body = await readBody(req);
  const id = sanitizeText(body.id, 40);

  if (!id) {
    return sendJson(res, 400, { ok: false, message: 'ID de movimiento requerido' });
  }

  const raw = readJson(ACCOUNTS_FILE, defaultAccounts());
  const accounts = normalizeAccountsState(raw);
  const filtered = accounts.entries.filter((item) => item.id !== id);

  if (filtered.length === accounts.entries.length) {
    return sendJson(res, 404, { ok: false, message: 'Movimiento no encontrado' });
  }

  const nextState = {
    entries: normalizeAccountEntries(filtered),
    payables: normalizeAccountsPayables(accounts.payables)
  };
  writeJson(ACCOUNTS_FILE, nextState);

  return sendJson(res, 200, {
    ok: true,
    message: 'Movimiento eliminado',
    entries: nextState.entries,
    payables: buildAccountsPayablesView(nextState),
    approvedCalculatorPrints: buildApprovedCalculatorPrintEntries(),
    summary: buildAccountsSummary(nextState)
  });
}

async function handleAccountsPayablesUpdate(req, res) {
  const body = await readBody(req);
  const source = body && typeof body === 'object'
    ? (body.payables && typeof body.payables === 'object' ? body.payables : body)
    : {};
  const raw = readJson(ACCOUNTS_FILE, defaultAccounts());
  const accounts = normalizeAccountsState(raw);
  const current = normalizeAccountsPayables(accounts.payables);

  const deudaPendiente = Object.prototype.hasOwnProperty.call(source, 'deudaPendiente')
    ? parseMoney(source.deudaPendiente)
    : (
      Object.prototype.hasOwnProperty.call(source, 'deuda')
        ? parseMoney(source.deuda)
        : (
          Object.prototype.hasOwnProperty.call(source, 'debtPending')
            ? parseMoney(source.debtPending)
            : current.deudaPendiente
        )
    );

  const payables = normalizeAccountsPayables({
    deudaPendiente,
    updatedAt: new Date().toISOString()
  });

  const nextState = {
    entries: normalizeAccountEntries(accounts.entries),
    payables
  };
  writeJson(ACCOUNTS_FILE, nextState);

  return sendJson(res, 200, {
    ok: true,
    message: 'Deuda pendiente actualizada',
    entries: nextState.entries,
    payables: buildAccountsPayablesView(nextState),
    approvedCalculatorPrints: buildApprovedCalculatorPrintEntries(),
    summary: buildAccountsSummary(nextState)
  });
}

function handleReportsGet(url, res) {
  const range = resolveReportsRange(url?.searchParams);
  const payload = buildReportsPayload(range);
  return sendJson(res, 200, {
    ok: true,
    ...payload
  });
}

function resolveReportsRange(searchParams) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultFrom = formatDateKeyLocal(monthStart);
  const defaultTo = formatDateKeyLocal(now);

  let fromDate = normalizeReportDateQuery(searchParams?.get('from')) || defaultFrom;
  let toDate = normalizeReportDateQuery(searchParams?.get('to')) || defaultTo;

  const fromAt = parseReportDateTime(fromDate, false);
  const toAt = parseReportDateTime(toDate, true);
  if (Number.isFinite(fromAt) && Number.isFinite(toAt) && fromAt > toAt) {
    const swap = fromDate;
    fromDate = toDate;
    toDate = swap;
  }

  return {
    fromDate,
    toDate,
    fromAt: parseReportDateTime(fromDate, false),
    toAt: parseReportDateTime(toDate, true)
  };
}

function normalizeReportDateQuery(value) {
  const clean = sanitizeText(value, 30);
  if (!clean) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  const parsed = new Date(clean).getTime();
  if (Number.isNaN(parsed)) {
    return '';
  }
  return formatDateKeyLocal(new Date(parsed));
}

function parseReportDateTime(dateInput, endOfDay = false) {
  const clean = normalizeReportDateQuery(dateInput);
  if (!clean) {
    return Number.NaN;
  }
  const date = new Date(`${clean}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return date.getTime();
}

function formatDateKeyLocal(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseSignedMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed);
}

function buildReportsPayload(range) {
  const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
  const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
  const clients = normalizeClients(clientsRaw.clients);
  const quotes = normalizeQuotes(quotesRaw.quotes).filter((quote) => !isQuoteDeletedRecord(quote));

  const quotesById = new Map();
  const quotesByRef = new Map();
  quotes.forEach((quote) => {
    const quoteId = sanitizeText(quote.id, 40).toLowerCase();
    const quoteRef = sanitizeText(quote.quoteNumber, 60).toLowerCase();
    if (quoteId && !quotesById.has(quoteId)) {
      quotesById.set(quoteId, quote);
    }
    if (quoteRef && !quotesByRef.has(quoteRef)) {
      quotesByRef.set(quoteRef, quote);
    }
  });

  const fallbackRatios = resolveAutomaticCostFallbackRatios(quotes);
  const fallbackCostFactor = resolveAutomaticCostEstimateFactor(quotes);
  const scopedClients = clients.filter((client) => {
    if (normalizeStatus(client.status) === 'cancelled') {
      return false;
    }
    const createdAt = new Date(resolveDueDateFromBody(client.createdAt) || '').getTime();
    if (Number.isNaN(createdAt)) {
      return false;
    }
    return createdAt >= range.fromAt && createdAt <= range.toAt;
  });

  const totals = {
    totalProjects: 0,
    paidProjects: 0,
    totalDue: 0,
    totalPaid: 0,
    totalCost: 0,
    totalEstimatedCost: 0,
    utilityReal: 0,
    utilityEstimated: 0,
    totalHours: 0,
    totalGrams: 0
  };
  const byDateMap = new Map();
  const byMachineMap = new Map();
  const byUtility = [];

  for (const client of scopedClients) {
    const linkedQuote = resolveLinkedQuoteForClient(client, quotesById, quotesByRef);
    const payment = resolveClientPaymentProgress(client, linkedQuote);
    const costBreakdown = resolveAutomaticPaidClientCosts(
      client,
      linkedQuote,
      fallbackRatios,
      fallbackCostFactor,
      quotes
    );

    let totalCostFull = parseMoney(
      parseMoney(costBreakdown.electricityCost)
      + parseMoney(costBreakdown.operatorPay)
      + parseMoney(costBreakdown.materialCost)
    );
    if (totalCostFull <= 0) {
      totalCostFull = parseMoney(client.costValue);
    }

    const paymentRatio = Math.max(0, Math.min(1, Number(payment.paymentRatio || 0)));
    const costAllocated = parseMoney(totalCostFull * paymentRatio);
    const totalDue = parseMoney(payment.totalDue || resolveClientTotalDue(client, linkedQuote));
    const paidValue = parseMoney(payment.paidValue);
    const utilityReal = parseSignedMoney(paidValue - costAllocated);
    const utilityEstimated = parseSignedMoney(totalDue - totalCostFull);
    const quoteMeta = normalizeCalculatorMeta(linkedQuote?.calculatorMeta);
    const quoteMode = normalizeCalculatorMode(quoteMeta?.mode);
    const printHours = (quoteMode === 'fdm' || quoteMode === 'resina')
      ? parseNonNegativeFloat(quoteMeta?.timeHours)
      : 0;
    const materialGrams = (quoteMode === 'fdm' || quoteMode === 'resina')
      ? parseNonNegativeFloat(quoteMeta?.materialGrams)
      : 0;
    const machine = sanitizeText(quoteMeta?.machineLabel, 80) || sanitizeText(client.machine, 80) || 'Sin asignar';
    const createdAt = resolveDueDateFromBody(client.createdAt) || new Date().toISOString();
    const paymentPct = parsePct(payment.paymentPct);
    const quoteRef = sanitizeText(client.quoteRef || linkedQuote?.quoteNumber, 80).toUpperCase();
    const project = sanitizeText(
      client.product || linkedQuote?.items?.[0]?.concept || linkedQuote?.notes,
      180
    ) || 'Sin proyecto';

    totals.totalProjects += 1;
    if (paidValue > 0) {
      totals.paidProjects += 1;
    }
    totals.totalDue += totalDue;
    totals.totalPaid += paidValue;
    totals.totalCost += costAllocated;
    totals.totalEstimatedCost += totalCostFull;
    totals.utilityReal += utilityReal;
    totals.utilityEstimated += utilityEstimated;
    totals.totalHours += printHours;
    totals.totalGrams += materialGrams;

    const dateKey = formatDateKeyLocal(createdAt);
    const dateRow = byDateMap.get(dateKey) || {
      date: dateKey || '-',
      projects: 0,
      totalPaid: 0,
      totalCost: 0,
      utilityReal: 0,
      paymentPctSum: 0
    };
    dateRow.projects += 1;
    dateRow.totalPaid += paidValue;
    dateRow.totalCost += costAllocated;
    dateRow.utilityReal += utilityReal;
    dateRow.paymentPctSum += paymentPct;
    byDateMap.set(dateKey, dateRow);

    const machineKey = machine.toLowerCase();
    const machineRow = byMachineMap.get(machineKey) || {
      machine,
      projects: 0,
      printHours: 0,
      materialGrams: 0,
      paidValue: 0,
      costAllocated: 0,
      utilityReal: 0,
      paymentPctSum: 0
    };
    machineRow.projects += 1;
    machineRow.printHours += printHours;
    machineRow.materialGrams += materialGrams;
    machineRow.paidValue += paidValue;
    machineRow.costAllocated += costAllocated;
    machineRow.utilityReal += utilityReal;
    machineRow.paymentPctSum += paymentPct;
    byMachineMap.set(machineKey, machineRow);

    byUtility.push({
      createdAt,
      client: sanitizeText(client.client, 80) || sanitizeText(linkedQuote?.clientName, 80) || 'Sin cliente',
      project,
      machine,
      quoteRef: quoteRef || '-',
      paidValue,
      costAllocated,
      utilityReal,
      paymentPct,
      status: statusLabel(normalizeStatus(client.status))
    });
  }

  const byDate = Array.from(byDateMap.values())
    .map((row) => ({
      date: row.date,
      projects: row.projects,
      totalPaid: parseMoney(row.totalPaid),
      totalCost: parseMoney(row.totalCost),
      utilityReal: parseSignedMoney(row.utilityReal),
      paymentPctAvg: row.projects > 0 ? parsePct(row.paymentPctSum / row.projects) : 0
    }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''), 'es'));

  byUtility.sort((a, b) => {
    const utilityDiff = parseSignedMoney(b.utilityReal) - parseSignedMoney(a.utilityReal);
    if (utilityDiff !== 0) {
      return utilityDiff;
    }
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const byMachine = Array.from(byMachineMap.values())
    .map((row) => ({
      machine: row.machine,
      projects: row.projects,
      printHours: roundTwo(row.printHours),
      materialGrams: roundTwo(row.materialGrams),
      paidValue: parseMoney(row.paidValue),
      costAllocated: parseMoney(row.costAllocated),
      utilityReal: parseSignedMoney(row.utilityReal),
      paymentPctAvg: row.projects > 0 ? parsePct(row.paymentPctSum / row.projects) : 0
    }))
    .sort((a, b) => {
      const utilityDiff = parseSignedMoney(b.utilityReal) - parseSignedMoney(a.utilityReal);
      if (utilityDiff !== 0) {
        return utilityDiff;
      }
      return b.projects - a.projects;
    });

  const totalPaid = parseMoney(totals.totalPaid);
  const totalCost = parseMoney(totals.totalCost);
  const utilityReal = parseSignedMoney(totals.utilityReal);
  const utilityEstimated = parseSignedMoney(totals.utilityEstimated);
  const paymentProgressPct = totals.totalDue > 0 ? parsePct((totalPaid / totals.totalDue) * 100) : 0;
  const realMarginPct = totalPaid > 0 ? parsePct((utilityReal / totalPaid) * 100) : 0;
  const estimatedMarginPct = totals.totalDue > 0
    ? parsePct((utilityEstimated / totals.totalDue) * 100)
    : 0;

  return {
    filters: {
      from: range.fromDate,
      to: range.toDate
    },
    summary: {
      totalProjects: totals.totalProjects,
      paidProjects: totals.paidProjects,
      totalPaid,
      totalCost,
      utilityReal,
      utilityEstimated,
      paymentProgressPct,
      realMarginPct,
      estimatedMarginPct,
      totalHours: roundTwo(totals.totalHours),
      totalGrams: roundTwo(totals.totalGrams)
    },
    byDate,
    byUtility,
    byMachine
  };
}

function buildSummaryFromBaseAndClients(dashboardBase, clients) {
  const base = normalizeSummary((dashboardBase || {}).salesSummary);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const monthClients = clients.filter((item) => new Date(item.createdAt) >= monthStart && item.status !== 'cancelled');
  const activeMonthClients = monthClients.filter((item) => item.status !== 'quoted');

  const clientsSales = activeMonthClients.reduce((sum, item) => sum + item.saleValue, 0);
  const clientsBalance = activeMonthClients.reduce((sum, item) => sum + (item.saleValue - item.costValue), 0);
  const clientsCompleted = activeMonthClients.filter((item) => item.status === 'delivered').length;
  const clientsPending = activeMonthClients.filter((item) => item.status !== 'delivered').length;

  const monthlyTotal = base.monthlyTotal + clientsSales;
  const netBalance = base.netBalance + clientsBalance;
  const completedOrders = base.completedOrders + clientsCompleted;
  const pendingOrders = base.pendingOrders + clientsPending;

  return {
    monthLabel: base.monthLabel,
    monthlyTotal,
    monthlyGoal: base.monthlyGoal,
    netBalance,
    completedOrders,
    pendingOrders,
    marginPct: monthlyTotal > 0 ? roundTwo((netBalance / monthlyTotal) * 100) : 0
  };
}

function buildMonthlyRevenueFromBaseAndClients(baseRevenue, clients) {
  const lastSix = [];
  const now = new Date();

  for (let idx = 5; idx >= 0; idx -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - idx, 1);
    lastSix.push({
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      month: monthLabel(date),
      value: 0
    });
  }

  const resultMap = new Map(lastSix.map((item) => [item.month, { ...item }]));

  const normalizedBase = normalizeMonthlyRevenue(baseRevenue);
  for (const item of normalizedBase) {
    if (resultMap.has(item.month)) {
      resultMap.get(item.month).value += item.value;
    }
  }

  for (const client of clients) {
    if (client.status === 'cancelled' || client.status === 'quoted') {
      continue;
    }
    const month = monthLabel(new Date(client.createdAt));
    if (resultMap.has(month)) {
      resultMap.get(month).value += client.saleValue;
    }
  }

  return lastSix.map((slot) => ({
    month: slot.month,
    value: Math.round(resultMap.get(slot.month).value)
  }));
}

function buildOrdersFromBaseAndClients(baseOrders, clients) {
  const normalizedBase = normalizeOrders(baseOrders || []);
  const now = Date.now();

  const clientOrders = clients
    .filter((item) => item.status !== 'delivered' && item.status !== 'cancelled' && item.status !== 'quoted')
    .map((item) => {
      const dueAt = new Date(item.dueAt).getTime();
      const minutesLeft = Math.round((dueAt - now) / 60000);
      return {
        id: item.id,
        client: item.client,
        product: item.product,
        printer: item.machine,
        status: statusLabel(item.status),
        dueAt: item.dueAt,
        minutesLeft,
        urgency: computeUrgency(minutesLeft)
      };
    });

  return [...normalizedBase, ...clientOrders].sort((a, b) => a.minutesLeft - b.minutesLeft);
}

function normalizeQuotes(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const createdAt = resolveDueDateFromBody(item.createdAt) || new Date().toISOString();
      const quoteDate = resolveDueDateFromBody(item.quoteDate || item.date) || createdAt;
      const updatedAt = resolveDueDateFromBody(item.updatedAt) || createdAt;
      const deletedAt = resolveDueDateFromBody(item.deletedAt) || '';
      const parsedItems = normalizeQuoteItems(item.items);
      const quoteNumber = sanitizeText(item.quoteNumber || item.number, 60) || 'COT-SIN-NUMERO';
      const notes = sanitizeText(item.notes, 1200);
      const source = normalizeRecordSource(item.source, inferQuoteSource(quoteNumber, notes));
      const hasSyncClientFlag = Object.prototype.hasOwnProperty.call(item || {}, 'syncClient');
      const syncClient = hasSyncClientFlag ? Boolean(item.syncClient) : source === 'calculadora';
      const discount = parseMoney(item.discount);
      const imageDataUrl = sanitizeImageDataUrl(item.imageDataUrl);
      const calculatorMeta = normalizeCalculatorMeta(item.calculatorMeta);
      const parsedSubtotalDesign = parseMoney(item.subtotalDesign);
      const parsedSubtotalPrint = parseMoney(item.subtotalPrint);
      const parsedGross = parseMoney(item.grossTotal);
      const parsedNet = parseMoney(item.netTotal);

      let subtotalDesign = parsedSubtotalDesign;
      let subtotalPrint = parsedSubtotalPrint;
      let grossTotal = parsedGross;
      let netTotal = parsedNet;

      if (parsedItems.length > 0) {
        const computed = computeQuoteTotalsFromItems(parsedItems);
        subtotalDesign = computed.subtotalDesign;
        subtotalPrint = computed.subtotalPrint;
        grossTotal = roundTwo(subtotalDesign + subtotalPrint);
        netTotal = Math.max(0, roundTwo(grossTotal - discount));
      } else {
        grossTotal = parsedGross > 0 ? parsedGross : roundTwo(subtotalDesign + subtotalPrint);
        netTotal = parsedNet > 0 ? parsedNet : Math.max(0, roundTwo(grossTotal - discount));
      }

      return {
        id: sanitizeText(item.id, 40) || generateQuoteId(),
        source,
        quoteNumber,
        quoteDate,
        companyName: sanitizeText(item.companyName, 80) || 'MOULE 3D',
        companyNit: sanitizeText(item.companyNit, 60),
        companyEmail: sanitizeText(item.companyEmail, 120),
        companyPhone: sanitizeText(item.companyPhone, 60),
        clientName: sanitizeText(item.clientName || item.client, 80) || 'Sin cliente',
        clientNit: sanitizeText(item.clientNit, 60),
        collectionDebtorEmail: sanitizeText(item.collectionDebtorEmail || item.debtorEmail, 120),
        collectionDebtorPhone: sanitizeText(item.collectionDebtorPhone || item.debtorPhone, 60),
        collectionDebtorAddress: sanitizeText(item.collectionDebtorAddress || item.debtorAddress, 180),
        notes,
        imageDataUrl,
        calculatorMeta,
        syncClient,
        discount,
        items: parsedItems,
        subtotalDesign,
        subtotalPrint,
        grossTotal,
        netTotal,
        approvedAt: resolveDueDateFromBody(item.approvedAt) || '',
        approvedClientId: sanitizeText(item.approvedClientId, 40),
        approvedTaskId: sanitizeText(item.approvedTaskId, 40),
        deletedAt,
        createdAt,
        updatedAt
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeCalculatorHistory(items) {
  const usedIds = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const createdAt = resolveDueDateFromBody(item.createdAt) || new Date().toISOString();
      const updatedAt = resolveDueDateFromBody(item.updatedAt) || createdAt;
      const mode = normalizeCalculatorMode(item.mode);
      const modeLabel = sanitizeText(item.modeLabel, 40) || calculatorModeLabelFromKey(mode);
      let id = sanitizeText(item.id, 40) || generateCalculatorHistoryId();
      while (!id || usedIds.has(id)) {
        id = generateCalculatorHistoryId();
      }
      usedIds.add(id);

      return {
        id,
        clientName: sanitizeText(item.clientName, 80) || 'Sin cliente',
        mode,
        modeLabel,
        status: normalizeCalculatorHistoryStatus(item.status),
        machineLabel: sanitizeText(item.machineLabel, 60),
        materialLabel: sanitizeText(item.materialLabel, 60),
        colorLabel: sanitizeText(item.colorLabel, 60),
        timeHours: parseNonNegativeFloat(item.timeHours),
        materialGrams: parseNonNegativeFloat(item.materialGrams),
        electricityCost: parseMoney(item.electricityCost),
        operatorPay: parseMoney(item.operatorPay),
        materialCost: parseMoney(item.materialCost),
        costPiece: parseMoney(item.costPiece),
        commercialValue: parseMoney(item.commercialValue),
        finalValue: parseMoney(item.finalValue),
        exchangeRate: parseNonNegativeFloat(item.exchangeRate),
        breakdown: sanitizeText(item.breakdown, 360),
        stockProcess: normalizeCalculatorStockProcess(item.stockProcess),
        stockMaterial: sanitizeText(item.stockMaterial, 40).toLowerCase(),
        stockColor: sanitizeText(item.stockColor, 40),
        stockGrams: parseNonNegativeFloat(item.stockGrams),
        quoteNumber: sanitizeText(item.quoteNumber, 60),
        quoteId: sanitizeText(item.quoteId, 40),
        inputSnapshot: normalizeCalculatorInputSnapshot(item.inputSnapshot),
        createdAt,
        updatedAt
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeCalculatorHistoryStatus(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['calculado', 'cotizado', 'aprobado', 'rechazado']);
  return allowed.has(clean) ? clean : 'calculado';
}

function normalizeCalculatorMode(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['fdm', 'resina', 'moldes', 'diseno']);
  return allowed.has(clean) ? clean : 'fdm';
}

function normalizeCalculatorContext(value) {
  return String(value || '').trim().toLowerCase() === 'tarea' ? 'tarea' : 'cotizacion';
}

function normalizeCalculatorStockProcess(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (clean === 'fdm' || clean === 'resina') {
    return clean;
  }
  return '';
}

function normalizeCalculatorInputSnapshot(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const mode = normalizeCalculatorMode(value.mode);
  const contextMode = normalizeCalculatorContext(value.contextMode);
  const snapshot = {
    mode,
    exchangeRate: parseNonNegativeFloat(value.exchangeRate),
    clientName: sanitizeText(value.clientName, 80),
    contextMode
  };

  if (contextMode === 'tarea') {
    snapshot.taskId = sanitizeText(value.taskId, 40);
    snapshot.taskClient = sanitizeText(value.taskClient, 80);
    snapshot.taskQuoteRef = sanitizeText(value.taskQuoteRef, 80);
  }

  if (mode === 'fdm') {
    snapshot.machine = sanitizeText(value.machine, 40).toLowerCase();
    snapshot.material = sanitizeText(value.material, 40).toLowerCase();
    snapshot.color = sanitizeText(value.color, 40);
    snapshot.meters = parseNonNegativeFloat(value.meters);
    snapshot.hours = parseNonNegativeFloat(value.hours);
    snapshot.minutes = parseNonNegativeFloat(value.minutes);
  } else if (mode === 'resina') {
    snapshot.material = sanitizeText(value.material, 40).toLowerCase();
    snapshot.color = sanitizeText(value.color, 40);
    snapshot.grams = parseNonNegativeFloat(value.grams);
    snapshot.hours = parseNonNegativeFloat(value.hours);
    snapshot.minutes = parseNonNegativeFloat(value.minutes);
  } else if (mode === 'moldes') {
    snapshot.mass = parseNonNegativeFloat(value.mass);
    snapshot.workHours = parseNonNegativeFloat(value.workHours);
    snapshot.siliconeKg = parseNonNegativeFloat(value.siliconeKg);
  } else {
    snapshot.designHours = parseNonNegativeFloat(value.designHours);
    snapshot.hourRate = parseNonNegativeFloat(value.hourRate);
  }

  return snapshot;
}

function normalizeQuoteItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const quantity = Math.max(1, parseCount(item.quantity || 1));
      const concept = sanitizeText(item.concept, 220);
      const designValue = parseMoney(item.designValue ?? item.design);
      const printValue = parseMoney(item.printValue ?? item.print);
      const rowTotal = roundTwo(quantity * (designValue + printValue));

      return {
        quantity,
        concept,
        designValue,
        printValue,
        rowTotal
      };
    })
    .filter((item) => item.concept || item.designValue > 0 || item.printValue > 0);
}

function computeQuoteTotalsFromItems(items) {
  let subtotalDesign = 0;
  let subtotalPrint = 0;

  for (const item of items) {
    subtotalDesign += item.quantity * item.designValue;
    subtotalPrint += item.quantity * item.printValue;
  }

  return {
    subtotalDesign: roundTwo(subtotalDesign),
    subtotalPrint: roundTwo(subtotalPrint)
  };
}

function normalizeClients(items) {
  const usedIds = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const dueAt = resolveDueDateFromBody(item.dueAt);
      const createdAt = resolveDueDateFromBody(item.createdAt) || new Date().toISOString();
      const quotedValue = parseMoney(item.quotedValue);
      const saleValue = parseMoney(item.saleValue);
      const electricityCost = parseMoney(
        item.electricityCost ?? item.electricity ?? item.lightCost ?? item.luzCost ?? item.luz
      );
      const operatorPay = parseMoney(
        item.operatorPay ?? item.operatorCost ?? item.operarioCost ?? item.operario
      );
      const materialCost = parseMoney(item.materialCost);
      const costValue = parseMoney(
        item.costValue
        ?? (electricityCost + operatorPay + materialCost)
      );
      const isPaidFlag = normalizeClientPaymentFlag(
        item.isPaid ?? item.paid ?? item.clientPaid ?? item.pagado
      );
      const totalDue = resolveClientTotalDue({ quotedValue, saleValue });
      const paidValue = resolveNextClientPaidValue({
        currentPaidValue: 0,
        requestedPaidValue: parseMoney(item.paidValue ?? item.paidAmount ?? item.abono ?? item.valorPagado),
        isPaid: isPaidFlag,
        totalDue
      });
      const isPaid = computeClientIsPaidState(isPaidFlag, paidValue, totalDue);
      const paidAt = paidValue > 0
        ? (
          resolveDueDateFromBody(item.paidAt || item.paymentAt || item.paidDate)
          || createdAt
        )
        : '';
      let id = sanitizeText(item.id, 40) || generateClientId();
      while (!id || usedIds.has(id)) {
        id = generateClientId();
      }
      usedIds.add(id);

      return {
        id,
        client: sanitizeText(item.client, 80) || 'Sin nombre',
        product: sanitizeText(item.product, 120) || 'Sin producto',
        machine: sanitizeText(item.machine, 60) || 'Sin asignar',
        source: normalizeRecordSource(item.source, 'manual'),
        quoteId: sanitizeText(item.quoteId, 40),
        quoteRef: sanitizeText(item.quoteRef, 80),
        quotedValue,
        saleValue,
        costValue,
        electricityCost,
        operatorPay,
        materialCost,
        dueAt: dueAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt,
        status: normalizeStatus(item.status),
        paidValue,
        isPaid,
        paidAt
      };
    })
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
}

function resolveClientTotalDue(client, linkedQuote = null) {
  const saleValue = parseMoney(client?.saleValue);
  const quotedValue = parseMoney(client?.quotedValue);
  let totalDue = Math.max(saleValue, quotedValue);

  if (linkedQuote) {
    totalDue = Math.max(
      totalDue,
      parseMoney(linkedQuote.netTotal),
      parseMoney(linkedQuote.grossTotal),
      parseMoney(linkedQuote.subtotalPrint)
    );
  }

  return totalDue;
}

function resolveNextClientPaidValue({
  currentPaidValue = 0,
  requestedPaidValue = 0,
  isPaid = false,
  totalDue = 0
}) {
  const normalizedRequested = parseMoney(requestedPaidValue);
  if (normalizedRequested > 0) {
    return normalizedRequested;
  }

  const normalizedCurrent = parseMoney(currentPaidValue);
  if (normalizedCurrent > 0) {
    return normalizedCurrent;
  }

  if (normalizeClientPaymentFlag(isPaid)) {
    const normalizedDue = parseMoney(totalDue);
    if (normalizedDue > 0) {
      return normalizedDue;
    }
  }

  return 0;
}

function computeClientIsPaidState(isPaidFlag, paidValue, totalDue) {
  const normalizedPaid = parseMoney(paidValue);
  const normalizedDue = parseMoney(totalDue);

  if (normalizedDue > 0) {
    return normalizeClientPaymentFlag(isPaidFlag) || normalizedPaid >= normalizedDue;
  }

  return normalizeClientPaymentFlag(isPaidFlag) || normalizedPaid > 0;
}

function normalizeClientProfiles(items) {
  const usedIds = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const createdAt = resolveDueDateFromBody(item.createdAt) || new Date().toISOString();
      const updatedAt = resolveDueDateFromBody(item.updatedAt) || createdAt;
      let id = sanitizeText(item.id, 40) || generateClientProfileId();
      while (!id || usedIds.has(id)) {
        id = generateClientProfileId();
      }
      usedIds.add(id);

      return {
        id,
        name: sanitizeText(item.name || item.client || item.clientName, 80) || 'Sin nombre',
        nit: sanitizeText(item.nit || item.clientNit, 60),
        email: sanitizeText(item.email || item.clientEmail || item.collectionDebtorEmail, 120),
        phone: sanitizeText(item.phone || item.clientPhone || item.collectionDebtorPhone, 60),
        address: sanitizeText(item.address, 180),
        notes: sanitizeText(item.notes, 300),
        createdAt,
        updatedAt
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

function normalizeTasks(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: sanitizeText(item.id, 40) || generateTaskId(),
      kind: normalizeTaskKind(item.kind),
      source: normalizeTaskSource(item.source),
      quoteId: sanitizeText(item.quoteId, 40),
      quoteRef: sanitizeText(item.quoteRef, 80),
      client: sanitizeText(item.client, 80),
      title: sanitizeText(item.title, 220) || 'Tarea sin titulo',
      notes: sanitizeText(item.notes, 400),
      details: sanitizeMultilineText(item.details, 2400),
      dueAt: resolveDueDateFromBody(item.dueAt) || '',
      status: normalizeTaskStatus(item.status),
      createdAt: resolveDueDateFromBody(item.createdAt) || new Date().toISOString()
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeTaskKind(value) {
  return String(value || '').trim().toLowerCase() === 'diseno' ? 'diseno' : 'impresion';
}

function normalizeTaskSource(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['calculadora', 'cotizacion', 'cuenta_cobro', 'clientes', 'manual']);
  return allowed.has(clean) ? clean : 'manual';
}

function normalizeTaskStatus(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['pending', 'in_progress', 'done', 'cancelled']);
  return allowed.has(clean) ? clean : 'pending';
}

function normalizePrinters(items) {
  const defaults = defaultPrinters().printers;
  const incoming = Array.isArray(items) ? items : [];
  const map = new Map();

  for (const item of incoming) {
    const id = sanitizeText(item.id, 40);
    if (!id) {
      continue;
    }
    map.set(id, item);
  }

  return defaults.map((base) => {
    const current = map.get(base.id) || {};
    return {
      id: base.id,
      name: base.name,
      type: base.type,
      status: normalizePrinterStatus(current.status || base.status),
      material: sanitizeText(current.material, 80),
      currentJob: sanitizeText(current.currentJob, 160),
      currentTaskId: sanitizeText(current.currentTaskId, 40),
      notes: sanitizeText(current.notes, 180),
      updatedAt: resolveDueDateFromBody(current.updatedAt) || base.updatedAt || new Date().toISOString()
    };
  });
}

function normalizeAccountsState(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    entries: normalizeAccountEntries(item.entries),
    payables: normalizeAccountsPayables(item.payables)
  };
}

function normalizeAccountEntries(items) {
  const usedIds = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const createdAt = resolveDueDateFromBody(item.createdAt) || new Date().toISOString();
      const updatedAt = resolveDueDateFromBody(item.updatedAt) || createdAt;
      const date = resolveDueDateFromBody(item.date || item.movedAt || item.createdAt) || createdAt;
      let id = sanitizeText(item.id, 40) || generateAccountEntryId();
      while (!id || usedIds.has(id)) {
        id = generateAccountEntryId();
      }
      usedIds.add(id);

      return {
        id,
        type: normalizeAccountEntryType(item.type || item.kind),
        date,
        account: sanitizeText(item.account || item.accountName || item.cuenta, 80),
        description: sanitizeText(item.description || item.notes || item.concept || item.detalle, 260),
        amount: parseMoney(item.amount ?? item.value ?? item.valor),
        attachmentDataUrl: sanitizeAccountAttachmentDataUrl(
          item.attachmentDataUrl || item.attachment || item.proofImageDataUrl || item.adjunto
        ),
        attachmentName: sanitizeText(
          item.attachmentName || item.attachmentFileName || item.attachmentLabel || item.adjuntoNombre,
          120
        ),
        createdAt,
        updatedAt
      };
    })
    .filter((item) => item.amount > 0 && (item.account || item.description))
    .sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
}

function normalizeAccountsPayables(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    deudaPendiente: parseMoney(item.deudaPendiente ?? item.deuda ?? item.debtPending),
    updatedAt: resolveDueDateFromBody(item.updatedAt) || new Date().toISOString()
  };
}

function normalizeAccountEntryType(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (clean === 'egreso' || clean === 'gasto' || clean === 'salida' || clean === 'expense') {
    return 'egreso';
  }
  return 'ingreso';
}

function buildAccountsSummary(accountsState) {
  return buildAccountsSummaryFromPayables(accountsState, buildAccountsPayablesView(accountsState));
}

function buildAccountsSummaryFromPayables(accountsState, payables) {
  const entries = normalizeAccountEntries(accountsState?.entries);
  const incomeTotal = entries
    .filter((item) => item.type === 'ingreso')
    .reduce((sum, item) => sum + item.amount, 0);
  const expenseTotal = entries
    .filter((item) => item.type === 'egreso')
    .reduce((sum, item) => sum + item.amount, 0);
  const netBalance = incomeTotal - expenseTotal;
  const payableTotal = payables.deudaPendiente
    + payables.luzPendiente
    + payables.operarioPendiente
    + payables.materialPendiente;

  return {
    incomeTotal: parseMoney(incomeTotal),
    expenseTotal: parseMoney(expenseTotal),
    netBalance,
    entryCount: entries.length,
    payableTotal: parseMoney(payableTotal),
    materialPendingBalance: parseMoney(payables.materialPendiente),
    grandPendingTotal: parseMoney(payableTotal),
    payables
  };
}

function buildAccountsPayablesView(accountsState) {
  const manual = normalizeAccountsPayables(accountsState?.payables);
  const automatic = buildAutomaticAccountsBundleFromPaidClients().payables;
  return {
    deudaPendiente: parseMoney(manual.deudaPendiente),
    luzPendiente: parseMoney(automatic.luzPendiente),
    operarioPendiente: parseMoney(automatic.operarioPendiente),
    materialPendiente: parseMoney(automatic.materialPendiente),
    updatedAt: manual.updatedAt
  };
}

function buildApprovedCalculatorPrintEntries() {
  return buildAutomaticAccountsBundleFromPaidClients().prints;
}

function buildAutomaticAccountsBundleFromPaidClients() {
  const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(clientsRaw.clients);
  const paidClients = clients.filter((item) => {
    const totalDue = resolveClientTotalDue(item);
    const paidValue = resolveNextClientPaidValue({
      currentPaidValue: item.paidValue,
      requestedPaidValue: item.paidValue,
      isPaid: item.isPaid,
      totalDue
    });
    return paidValue > 0;
  });

  if (paidClients.length === 0) {
    return {
      payables: {
        luzPendiente: 0,
        operarioPendiente: 0,
        materialPendiente: 0
      },
      prints: []
    };
  }

  const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
  const quotes = normalizeQuotes(quotesRaw.quotes).filter((quote) => !isQuoteDeletedRecord(quote));
  const fallbackRatios = resolveAutomaticCostFallbackRatios(quotes);
  const fallbackCostFactor = resolveAutomaticCostEstimateFactor(quotes);
  const quotesById = new Map();
  const quotesByRef = new Map();

  for (const quote of quotes) {
    const quoteId = sanitizeText(quote.id, 40).toLowerCase();
    const quoteRef = sanitizeText(quote.quoteNumber, 60).toLowerCase();
    if (quoteId && !quotesById.has(quoteId)) {
      quotesById.set(quoteId, quote);
    }
    if (quoteRef && !quotesByRef.has(quoteRef)) {
      quotesByRef.set(quoteRef, quote);
    }
  }

  const prints = [];

  for (const client of paidClients) {
    const linkedQuote = resolveLinkedQuoteForClient(client, quotesById, quotesByRef);
    const payment = resolveClientPaymentProgress(client, linkedQuote);
    if (payment.paidValue <= 0 || payment.paymentRatio <= 0) {
      continue;
    }

    const {
      mode,
      electricityCost: baseElectricityCost,
      operatorPay: baseOperatorPay,
      materialCost: baseMaterialCost
    } = resolveAutomaticPaidClientCosts(client, linkedQuote, fallbackRatios, fallbackCostFactor, quotes);
    const electricityCost = parseMoney(baseElectricityCost * payment.paymentRatio);
    const operatorPay = parseMoney(baseOperatorPay * payment.paymentRatio);
    const materialCost = parseMoney(baseMaterialCost * payment.paymentRatio);
    let quoteNumber = sanitizeText(client.quoteRef, 80).toUpperCase();
    let clientName = sanitizeText(client.client, 80) || 'Sin cliente';

    if (linkedQuote) {
      quoteNumber = sanitizeText(linkedQuote.quoteNumber, 60).toUpperCase() || quoteNumber;
      clientName = sanitizeText(linkedQuote.clientName, 80) || clientName;
    }

    if (electricityCost <= 0 && operatorPay <= 0 && materialCost <= 0) {
      continue;
    }

    prints.push({
      id: sanitizeText(client.id, 40) || sanitizeText(linkedQuote?.id, 40),
      createdAt: resolveDueDateFromBody(client.paidAt) || resolveDueDateFromBody(client.createdAt) || new Date().toISOString(),
      clientName,
      mode,
      quoteNumber,
      paidValue: payment.paidValue,
      totalDue: payment.totalDue,
      paymentPct: payment.paymentPct,
      paymentStatus: payment.paymentStatus,
      electricityCost,
      operatorPay,
      materialCost,
      total: parseMoney(electricityCost + operatorPay + materialCost)
    });
  }

  prints.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totals = prints.reduce(
    (acc, item) => {
      acc.luzPendiente += parseMoney(item.electricityCost);
      acc.operarioPendiente += parseMoney(item.operatorPay);
      acc.materialPendiente += parseMoney(item.materialCost);
      return acc;
    },
    { luzPendiente: 0, operarioPendiente: 0, materialPendiente: 0 }
  );

  return {
    payables: {
      luzPendiente: parseMoney(totals.luzPendiente),
      operarioPendiente: parseMoney(totals.operarioPendiente),
      materialPendiente: parseMoney(totals.materialPendiente)
    },
    prints
  };
}

function resolveClientPaymentProgress(client, linkedQuote = null) {
  const totalDue = resolveClientTotalDue(client, linkedQuote);
  const paidValue = resolveNextClientPaidValue({
    currentPaidValue: client?.paidValue,
    requestedPaidValue: client?.paidValue,
    isPaid: client?.isPaid,
    totalDue
  });

  if (paidValue <= 0) {
    return {
      paidValue: 0,
      totalDue,
      paymentRatio: 0,
      paymentPct: 0,
      paymentStatus: 'sin_pago'
    };
  }

  const ratioRaw = totalDue > 0 ? (paidValue / totalDue) : 1;
  const paymentRatio = Math.max(0, Math.min(1, ratioRaw));
  const paymentPct = totalDue > 0 ? parsePct(paymentRatio * 100) : 100;
  const paymentStatus = paymentRatio >= 1 ? 'completo' : 'parcial';

  return {
    paidValue,
    totalDue,
    paymentRatio,
    paymentPct,
    paymentStatus
  };
}

function resolveLinkedQuoteForClient(client, quotesById, quotesByRef) {
  const quoteId = sanitizeText(client?.quoteId, 40).toLowerCase();
  if (quoteId && quotesById.has(quoteId)) {
    return quotesById.get(quoteId);
  }

  const quoteRef = sanitizeText(client?.quoteRef, 80).toLowerCase();
  if (quoteRef && quotesByRef.has(quoteRef)) {
    return quotesByRef.get(quoteRef);
  }

  return null;
}

function resolveAutomaticPaidClientCosts(client, linkedQuote, fallbackRatios, fallbackCostFactor, allQuotes = []) {
  const fromQuote = resolveCostBreakdownFromLinkedQuote(linkedQuote);
  if (fromQuote) {
    return fromQuote;
  }

  const matchedClientCostBreakdown = resolveCostBreakdownByClientCostMatch(client, allQuotes);
  if (matchedClientCostBreakdown) {
    return matchedClientCostBreakdown;
  }

  const directClientBreakdown = resolveCostBreakdownFromClientRecord(client);
  if (directClientBreakdown) {
    return directClientBreakdown;
  }

  const fallbackBase = resolveFallbackBaseCost(client, linkedQuote, fallbackCostFactor);
  if (fallbackBase <= 0) {
    return {
      mode: inferAutomaticWorkMode(client, linkedQuote),
      electricityCost: 0,
      operatorPay: 0,
      materialCost: 0
    };
  }

  const distributed = splitCostWithRatios(fallbackBase, fallbackRatios);
  return {
    mode: inferAutomaticWorkMode(client, linkedQuote),
    electricityCost: distributed.electricityCost,
    operatorPay: distributed.operatorPay,
    materialCost: distributed.materialCost
  };
}

function resolveCostBreakdownFromLinkedQuote(linkedQuote) {
  if (!linkedQuote) {
    return null;
  }

  const source = normalizeRecordSource(
    linkedQuote.source,
    inferQuoteSource(linkedQuote.quoteNumber, linkedQuote.notes)
  );
  if (source !== 'calculadora') {
    return null;
  }

  const calculatorMeta = normalizeCalculatorMeta(linkedQuote.calculatorMeta);
  const normalizedMode = normalizeCalculatorMode(calculatorMeta?.mode);
  if (normalizedMode !== 'fdm' && normalizedMode !== 'resina') {
    return null;
  }

  const electricityCost = parseMoney(calculatorMeta?.electricityCost);
  const operatorPay = parseMoney(calculatorMeta?.operatorPay);
  const materialCost = parseMoney(calculatorMeta?.materialCost);
  if (electricityCost <= 0 && operatorPay <= 0 && materialCost <= 0) {
    return null;
  }

  return {
    mode: normalizedMode,
    electricityCost,
    operatorPay,
    materialCost
  };
}

function resolveCostBreakdownFromClientRecord(client) {
  const electricityCost = parseMoney(
    client?.electricityCost ?? client?.electricity ?? client?.lightCost ?? client?.luzCost ?? client?.luz
  );
  const operatorPay = parseMoney(
    client?.operatorPay ?? client?.operatorCost ?? client?.operarioCost ?? client?.operario
  );
  const materialCost = parseMoney(client?.materialCost);
  const costValue = parseMoney(client?.costValue);

  // Evita el caso heredado donde todo el costo se guardo en material.
  if (
    electricityCost <= 0
    && operatorPay <= 0
    && materialCost > 0
    && costValue > 0
    && Math.abs(materialCost - costValue) <= 3
  ) {
    return null;
  }

  if (electricityCost <= 0 && operatorPay <= 0 && materialCost <= 0) {
    return null;
  }

  return {
    mode: inferAutomaticWorkMode(client, null),
    electricityCost,
    operatorPay,
    materialCost
  };
}

function resolveCostBreakdownByClientCostMatch(client, quotes) {
  const targetCost = parseMoney(client?.costValue);
  const targetClient = normalizeClientNameKey(client?.client);

  if (targetCost <= 0 || !targetClient) {
    return null;
  }

  const clientCreatedAt = new Date(resolveDueDateFromBody(client?.createdAt) || 0).getTime() || 0;
  let bestMatch = null;
  let bestTimeDelta = Number.POSITIVE_INFINITY;

  for (const quote of Array.isArray(quotes) ? quotes : []) {
    const cost = resolveCostBreakdownFromLinkedQuote(quote);
    if (!cost) {
      continue;
    }

    const quoteClient = normalizeClientNameKey(quote?.clientName);
    if (!quoteClient || quoteClient !== targetClient) {
      continue;
    }

    const calculatorMeta = normalizeCalculatorMeta(quote?.calculatorMeta);
    const quoteCostTotal = parseMoney(
      calculatorMeta?.totalCost
      || (cost.electricityCost + cost.operatorPay + cost.materialCost)
    );
    if (Math.abs(quoteCostTotal - targetCost) > 3) {
      continue;
    }

    const quoteCreatedAt = new Date(resolveDueDateFromBody(quote?.createdAt) || 0).getTime() || 0;
    const timeDelta = Math.abs(quoteCreatedAt - clientCreatedAt);
    if (!bestMatch || timeDelta < bestTimeDelta) {
      bestMatch = cost;
      bestTimeDelta = timeDelta;
    }
  }

  return bestMatch;
}

function normalizeClientNameKey(value) {
  return sanitizeText(value, 120).toLowerCase();
}

function resolveFallbackBaseCost(client, linkedQuote, fallbackCostFactor) {
  const estimateFactor = Number.isFinite(Number(fallbackCostFactor)) && Number(fallbackCostFactor) > 0
    ? Number(fallbackCostFactor)
    : 0.42;
  const clientCost = parseMoney(client?.costValue);
  if (clientCost > 0) {
    return clientCost;
  }

  if (linkedQuote) {
    const quoteMeta = normalizeCalculatorMeta(linkedQuote.calculatorMeta);
    const quoteMetaTotalCost = parseMoney(quoteMeta?.totalCost);
    if (quoteMetaTotalCost > 0) {
      return quoteMetaTotalCost;
    }

    const quotePrintSubtotal = parseMoney(linkedQuote.subtotalPrint);
    if (quotePrintSubtotal > 0) {
      return parseMoney(quotePrintSubtotal * estimateFactor);
    }

    const quoteGross = parseMoney(linkedQuote.grossTotal);
    if (quoteGross > 0) {
      return parseMoney(quoteGross * estimateFactor);
    }

    const quoteNet = parseMoney(linkedQuote.netTotal);
    if (quoteNet > 0) {
      return parseMoney(quoteNet * estimateFactor);
    }
  }

  const quotedValue = parseMoney(client?.quotedValue);
  if (quotedValue > 0) {
    return parseMoney(quotedValue * estimateFactor);
  }

  return parseMoney(parseMoney(client?.saleValue) * estimateFactor);
}

function inferAutomaticWorkMode(client, linkedQuote) {
  const quoteMode = normalizeCalculatorMode(normalizeCalculatorMeta(linkedQuote?.calculatorMeta)?.mode);
  if (quoteMode === 'fdm' || quoteMode === 'resina') {
    return quoteMode;
  }

  const machine = sanitizeText(client?.machine, 80).toLowerCase();
  if (machine.includes('resina') || machine.includes('mono')) {
    return 'resina';
  }

  const product = sanitizeText(client?.product, 160).toLowerCase();
  if (product.includes('resina')) {
    return 'resina';
  }
  if (product.includes('fdm') || machine.includes('k1') || machine.includes('kobra') || product.includes('impresion')) {
    return 'fdm';
  }

  return 'manual';
}

function resolveAutomaticCostFallbackRatios(quotes) {
  const totals = {
    electricityCost: 0,
    operatorPay: 0,
    materialCost: 0
  };

  for (const quote of Array.isArray(quotes) ? quotes : []) {
    const cost = resolveCostBreakdownFromLinkedQuote(quote);
    if (!cost) {
      continue;
    }
    totals.electricityCost += parseMoney(cost.electricityCost);
    totals.operatorPay += parseMoney(cost.operatorPay);
    totals.materialCost += parseMoney(cost.materialCost);
  }

  const knownTotal = totals.electricityCost + totals.operatorPay + totals.materialCost;
  if (knownTotal > 0) {
    return {
      electricityCost: totals.electricityCost / knownTotal,
      operatorPay: totals.operatorPay / knownTotal,
      materialCost: totals.materialCost / knownTotal
    };
  }

  return {
    electricityCost: 0.13,
    operatorPay: 0.19,
    materialCost: 0.68
  };
}

function resolveAutomaticCostEstimateFactor(quotes) {
  let totalCost = 0;
  let totalSale = 0;

  for (const quote of Array.isArray(quotes) ? quotes : []) {
    const cost = resolveCostBreakdownFromLinkedQuote(quote);
    if (!cost) {
      continue;
    }

    const costTotal = parseMoney(cost.electricityCost + cost.operatorPay + cost.materialCost);
    if (costTotal <= 0) {
      continue;
    }

    const calculatorMeta = normalizeCalculatorMeta(quote.calculatorMeta);
    const sale = parseMoney(
      calculatorMeta?.finalValue
      || quote?.netTotal
      || quote?.grossTotal
      || quote?.subtotalPrint
    );
    if (sale <= 0) {
      continue;
    }

    totalCost += costTotal;
    totalSale += sale;
  }

  if (totalCost > 0 && totalSale > 0) {
    const ratio = totalCost / totalSale;
    return Math.max(0.2, Math.min(0.9, ratio));
  }

  return 0.42;
}

function splitCostWithRatios(totalCost, ratios) {
  const total = parseMoney(totalCost);
  if (total <= 0) {
    return {
      electricityCost: 0,
      operatorPay: 0,
      materialCost: 0
    };
  }

  const electricityRatio = Math.max(0, Number(ratios?.electricityCost || 0));
  const operatorRatio = Math.max(0, Number(ratios?.operatorPay || 0));
  const materialRatio = Math.max(0, Number(ratios?.materialCost || 0));
  const ratioSum = electricityRatio + operatorRatio + materialRatio;

  if (ratioSum <= 0) {
    return {
      electricityCost: 0,
      operatorPay: 0,
      materialCost: total
    };
  }

  const normalizedElectricity = electricityRatio / ratioSum;
  const normalizedOperator = operatorRatio / ratioSum;
  const electricityCost = parseMoney(total * normalizedElectricity);
  const operatorPay = parseMoney(total * normalizedOperator);
  const materialCost = Math.max(0, parseMoney(total - electricityCost - operatorPay));

  return {
    electricityCost,
    operatorPay,
    materialCost
  };
}

function normalizePrinterStatus(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['libre', 'ocupada', 'mantenimiento']);
  return allowed.has(clean) ? clean : 'libre';
}

function normalizeStatus(value) {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['quoted', 'pending', 'in_progress', 'ready', 'delivered', 'cancelled']);
  return allowed.has(clean) ? clean : 'pending';
}

function normalizeClientPaymentFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }

  const clean = String(value || '').trim().toLowerCase();
  const truthy = new Set(['1', 'true', 'si', 'sí', 'yes', 'y', 'on']);
  return truthy.has(clean);
}

function findClientIndexBySourceAndQuoteRef(clients, source, quoteRef) {
  const list = Array.isArray(clients) ? clients : [];
  const targetRef = sanitizeText(quoteRef, 80).toLowerCase();
  if (!targetRef) {
    return -1;
  }

  const targetSource = normalizeRecordSource(source, '');
  let bestIndex = -1;
  let bestScore = -1;
  let bestCreatedAt = 0;

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (String(item.quoteRef || '').trim().toLowerCase() !== targetRef) {
      continue;
    }
    if (targetSource && normalizeRecordSource(item.source, 'manual') !== targetSource) {
      continue;
    }

    let score = 0;
    if (normalizeStatus(item.status) !== 'cancelled') {
      score += 2;
    }
    if (parseMoney(item.saleValue) > 0) {
      score += 2;
    }
    if (normalizeStatus(item.status) !== 'quoted') {
      score += 1;
    }
    const createdAt = new Date(resolveDueDateFromBody(item.createdAt) || 0).getTime() || 0;

    if (score > bestScore || (score === bestScore && createdAt > bestCreatedAt)) {
      bestScore = score;
      bestCreatedAt = createdAt;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function statusLabel(status) {
  const map = {
    quoted: 'Cotizado',
    pending: 'Pendiente',
    in_progress: 'En produccion',
    ready: 'Lista para entrega',
    delivered: 'Entregada',
    cancelled: 'Cancelada'
  };
  return map[status] || 'Pendiente';
}

function requireSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.moule_session;

  if (!token) {
    sendJson(res, 401, { ok: false, message: 'No autorizado' });
    return null;
  }

  const session = verifySessionToken(token);
  if (!session) {
    clearSessionCookie(res);
    sendJson(res, 401, { ok: false, message: 'Sesion expirada o invalida' });
    return null;
  }

  return session;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const value = [
    `moule_session=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'SameSite=Lax'
  ].join('; ') + secure;

  res.setHeader('Set-Cookie', value);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'moule_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

function createSessionToken(payload) {
  const sessionPayload = {
    ...payload,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  };
  const encodedPayload = toBase64Url(JSON.stringify(sessionPayload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  const [encodedPayload, providedSignature] = String(token || '').split('.');
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  if (!safeEqual(providedSignature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function verifyPassword(password, salt, expectedHash) {
  const hash = hashPassword(password, salt);
  return safeEqual(hash, expectedHash);
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}${password}`).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const parts = String(cookieHeader || '').split(';');

  for (const part of parts) {
    const [rawKey, ...rawValueParts] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }
    cookies[rawKey] = decodeURIComponent(rawValueParts.join('='));
  }

  return cookies;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function normalizeSummary(rawSummary) {
  const summary = rawSummary || {};
  return {
    monthLabel: sanitizeText(summary.monthLabel, 20) || monthLabel(new Date()),
    monthlyTotal: parseMoney(summary.monthlyTotal),
    monthlyGoal: parseMoney(summary.monthlyGoal),
    netBalance: parseMoney(summary.netBalance),
    completedOrders: parseCount(summary.completedOrders),
    pendingOrders: parseCount(summary.pendingOrders),
    marginPct: parsePct(summary.marginPct)
  };
}

function normalizeMonthlyRevenue(rawRevenue) {
  const entries = Array.isArray(rawRevenue) ? rawRevenue : [];
  const normalized = entries
    .map((item) => ({
      month: sanitizeText(item.month, 8),
      value: parseMoney(item.value)
    }))
    .filter((item) => item.month)
    .slice(-6);

  if (normalized.length === 0) {
    return defaultMonthlyRevenue();
  }

  return normalized;
}

function normalizeOrders(orders) {
  const now = Date.now();

  return (Array.isArray(orders) ? orders : [])
    .map((order) => {
      const dueAt = resolveDueDate(order, now);
      const minutesLeft = Math.round((dueAt - now) / 60000);
      return {
        id: sanitizeText(order.id, 30) || generateOrderId(),
        client: sanitizeText(order.client, 80) || 'Sin cliente',
        product: sanitizeText(order.product, 120) || 'Sin detalle',
        printer: sanitizeText(order.printer, 60) || 'Sin asignar',
        status: sanitizeText(order.status, 40) || 'Pendiente',
        dueAt: new Date(dueAt).toISOString(),
        minutesLeft,
        urgency: computeUrgency(minutesLeft)
      };
    })
    .sort((a, b) => a.minutesLeft - b.minutesLeft);
}

function resolveDueDate(order, now) {
  if (order.dueAt) {
    const parsed = new Date(order.dueAt).getTime();
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (Number.isFinite(order.dueInHours)) {
    return now + Number(order.dueInHours) * 60 * 60 * 1000;
  }

  return now + 24 * 60 * 60 * 1000;
}

function resolveDueDateFromBody(rawValue) {
  const parsed = new Date(String(rawValue || '')).getTime();
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function computeUrgency(minutesLeft) {
  if (minutesLeft <= 0) {
    return 'vencida';
  }
  if (minutesLeft <= 120) {
    return 'critica';
  }
  if (minutesLeft <= 480) {
    return 'alta';
  }
  if (minutesLeft <= 1440) {
    return 'media';
  }
  return 'baja';
}

function normalizeStock(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const map = new Map();

  for (const item of items) {
    const category = normalizeStockCategory(item.category, item.process || item.type, item.material);

    if (category === 'materiales') {
      const process = normalizeStockProcess(item.process || item.type, item.material);
      const material = resolveStockMaterial(
        process,
        item.material,
        process === 'resina' ? 'estandar' : 'pla'
      );
      const color = sanitizeText(item.color, 40);
      if (!color) {
        continue;
      }
      const grams = parseGrams(item.grams);
      if (!Number.isFinite(grams) || grams < 0) {
        continue;
      }

      const key = `${category}|${process}|${material}|${color.toLowerCase()}`;
      const current = map.get(key);
      if (current) {
        current.grams = roundTwo(current.grams + grams);
      } else {
        map.set(key, {
          category,
          process,
          material,
          color,
          grams: roundTwo(grams)
        });
      }
      continue;
    }

    const name = sanitizeText(item.name || item.item || item.description, 80);
    const quantity = parseCount(item.quantity ?? item.units ?? item.amount);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }

    const key = `${category}|${name.toLowerCase()}`;
    const current = map.get(key);
    if (current) {
      current.quantity = parseCount(current.quantity + quantity);
    } else {
      map.set(key, {
        category,
        name,
        quantity: parseCount(quantity)
      });
    }
  }

  return sortStockItems(Array.from(map.values()));
}

function sortStockItems(items) {
  const categoryOrder = {
    materiales: 0,
    repuestos: 1,
    otros: 2
  };

  const processOrder = {
    fdm: 0,
    resina: 1
  };

  return items.sort((a, b) => {
    const categoryA = categoryOrder[normalizeStockCategory(a.category, a.process, a.material)] ?? 9;
    const categoryB = categoryOrder[normalizeStockCategory(b.category, b.process, b.material)] ?? 9;
    if (categoryA !== categoryB) {
      return categoryA - categoryB;
    }

    if (normalizeStockCategory(a.category, a.process, a.material) !== 'materiales') {
      return String(a.name || '').localeCompare(String(b.name || ''), 'es');
    }

    const processA = processOrder[a.process] ?? 9;
    const processB = processOrder[b.process] ?? 9;
    if (processA !== processB) {
      return processA - processB;
    }
    const materialDiff = String(a.material || '').localeCompare(String(b.material || ''), 'es');
    if (materialDiff !== 0) {
      return materialDiff;
    }
    return String(a.color || '').localeCompare(String(b.color || ''), 'es');
  });
}

function normalizeStockCategory(value, processHint, materialHint) {
  const clean = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (clean === 'materiales' || clean === 'material' || clean === 'materials') {
    return 'materiales';
  }
  if (clean === 'repuestos' || clean === 'repuesto' || clean === 'parts') {
    return 'repuestos';
  }
  if (clean === 'otros' || clean === 'other' || clean === 'others') {
    return 'otros';
  }

  if (processHint || materialHint) {
    return 'materiales';
  }

  return 'materiales';
}

function normalizeStockProcess(value, materialHint) {
  const clean = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (clean === 'resina' || clean === 'resin') {
    return 'resina';
  }
  if (clean === 'fdm' || clean === 'filamento' || clean === 'filament') {
    return 'fdm';
  }

  const hint = String(materialHint || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (RESIN_STOCK_MATERIALS.has(hint)) {
    return 'resina';
  }
  if (FDM_STOCK_MATERIALS.has(hint)) {
    return 'fdm';
  }

  return 'fdm';
}

function resolveStockMaterial(process, value, fallback = 'sin_material') {
  const clean = sanitizeText(value, 40).toLowerCase().replace(/\s+/g, '_');
  if (clean && clean !== 'sin_material') {
    return clean;
  }

  if (String(fallback || '').trim()) {
    return String(fallback).trim().toLowerCase().replace(/\s+/g, '_');
  }

  return process === 'resina' ? 'estandar' : 'pla';
}

function findStockIndex(items, process, material, color) {
  const processKey = normalizeStockProcess(process, material);
  const materialKey = resolveStockMaterial(processKey, material, processKey === 'resina' ? 'estandar' : 'pla');
  const colorKey = String(color || '').trim().toLowerCase();
  return items.findIndex(
    (item) =>
      normalizeStockCategory(item.category, item.process, item.material) === 'materiales' &&
      String(item.process || '').toLowerCase() === processKey &&
      String(item.material || '').toLowerCase() === materialKey &&
      String(item.color || '').toLowerCase() === colorKey
  );
}

function findGeneralStockIndex(items, category, name) {
  const categoryKey = normalizeStockCategory(category);
  const nameKey = sanitizeText(name, 80).toLowerCase();
  return items.findIndex(
    (item) =>
      normalizeStockCategory(item.category, item.process, item.material) === categoryKey &&
      String(item.name || '').toLowerCase() === nameKey
  );
}

function upsertMaterialStock(items, process, material, color, delta) {
  const processKey = normalizeStockProcess(process, material);
  const materialKey = resolveStockMaterial(
    processKey,
    material,
    processKey === 'resina' ? 'estandar' : 'pla'
  );
  const colorKey = sanitizeText(color, 40);
  const index = findStockIndex(items, processKey, materialKey, colorKey);

  if (index >= 0) {
    items[index].grams = roundTwo(items[index].grams + delta);
    return;
  }

  items.push({
    category: 'materiales',
    process: processKey,
    material: materialKey,
    color: colorKey,
    grams: roundTwo(delta)
  });

  sortStockItems(items);
}

function upsertGeneralStock(items, category, name, quantity) {
  const categoryKey = normalizeStockCategory(category);
  const nameKey = sanitizeText(name, 80);
  const qty = parseCount(quantity);
  const index = findGeneralStockIndex(items, categoryKey, nameKey);

  if (index >= 0) {
    items[index].quantity = parseCount(Number(items[index].quantity || 0) + qty);
    return;
  }

  items.push({
    category: categoryKey,
    name: nameKey,
    quantity: qty
  });

  sortStockItems(items);
}

function stockCategoryLabel(category) {
  const key = normalizeStockCategory(category);
  const labels = {
    materiales: 'Materiales',
    repuestos: 'Repuestos',
    otros: 'Otros'
  };
  return labels[key] || 'Materiales';
}

function stockProcessLabel(process) {
  return normalizeStockProcess(process) === 'resina' ? 'Resina' : 'FDM';
}

function stockMaterialLabel(material) {
  const key = String(material || '').trim().toLowerCase().replace(/\s+/g, '_');
  const labels = {
    pla: 'PLA',
    pla_pro: 'PLA Pro',
    petg: 'PETG',
    elastico: 'Elastico',
    tpu: 'TPU',
    abs: 'ABS',
    estandar: 'Estandar',
    flex: 'Flex',
    high_speed: 'High Speed',
    casteable: 'Casteable',
    alta_dureza: 'Alta Dureza',
    biocompatible: 'Biocompatible',
    sin_material: 'Sin material'
  };
  return labels[key] || key || 'Sin material';
}

function normalizeRecordSource(value, fallback = 'manual') {
  const clean = String(value || '').trim().toLowerCase();
  const allowed = new Set(['calculadora', 'cotizacion', 'cuenta_cobro', 'clientes', 'manual']);
  if (allowed.has(clean)) {
    return clean;
  }
  const fallbackClean = String(fallback || '').trim().toLowerCase();
  if (!fallbackClean) {
    return '';
  }
  return allowed.has(fallbackClean) ? fallbackClean : 'manual';
}

function inferQuoteSource(quoteNumber, notes) {
  const number = String(quoteNumber || '').trim().toUpperCase();
  const noteValue = String(notes || '').trim().toLowerCase();
  if (number.startsWith('CALC-') || noteValue.includes('origen: calculadora')) {
    return 'calculadora';
  }
  if (
    number.startsWith('CCB-')
    || number.startsWith('CC-')
    || noteValue.includes('cuenta de cobro')
  ) {
    return 'cuenta_cobro';
  }
  return 'cotizacion';
}

function isQuoteDeletedRecord(quote) {
  return Boolean(resolveDueDateFromBody(quote?.deletedAt));
}

function quoteSerialKindFromSource(source) {
  const normalized = normalizeRecordSource(source, '');
  if (normalized === 'cuenta_cobro') {
    return 'cuenta_cobro';
  }
  if (normalized === 'cotizacion') {
    return 'cotizacion';
  }
  return '';
}

function quoteSerialPrefix(kind) {
  return kind === 'cuenta_cobro' ? 'CCB' : 'COT';
}

function sanitizeSerialCounter(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function normalizeQuoteSerialsState(value) {
  const item = value && typeof value === 'object' ? value : {};
  return {
    cotizacion: {
      next: sanitizeSerialCounter(item?.cotizacion?.next, 1)
    },
    cuenta_cobro: {
      next: sanitizeSerialCounter(item?.cuenta_cobro?.next, 1)
    },
    updatedAt: resolveDueDateFromBody(item?.updatedAt) || new Date().toISOString()
  };
}

function parseQuoteSerialNumber(quoteNumber, kind) {
  const prefix = quoteSerialPrefix(kind);
  const expression = new RegExp(`^${prefix}-(\\d{6,})$`, 'i');
  const match = String(quoteNumber || '').trim().toUpperCase().match(expression);
  if (!match) {
    return 0;
  }
  return sanitizeSerialCounter(match[1], 0);
}

function formatQuoteSerialNumber(kind, serial) {
  const prefix = quoteSerialPrefix(kind);
  const safeSerial = sanitizeSerialCounter(serial, 1);
  return `${prefix}-${String(safeSerial).padStart(6, '0')}`;
}

function readQuoteSerials() {
  const raw = readJson(QUOTE_SERIALS_FILE, defaultQuoteSerials());
  return normalizeQuoteSerialsState(raw);
}

function writeQuoteSerials(state) {
  const normalized = normalizeQuoteSerialsState(state);
  normalized.updatedAt = new Date().toISOString();
  writeJson(QUOTE_SERIALS_FILE, normalized);
}

function ensureQuoteSerialState(quotesInput = null) {
  const serials = readQuoteSerials();
  const quotes = Array.isArray(quotesInput)
    ? normalizeQuotes(quotesInput)
    : normalizeQuotes(readJson(QUOTES_FILE, defaultQuotes()).quotes);
  let maxCotizacion = 0;
  let maxCuentaCobro = 0;

  for (const quote of quotes) {
    const cotSerial = parseQuoteSerialNumber(quote?.quoteNumber, 'cotizacion');
    if (cotSerial > maxCotizacion) {
      maxCotizacion = cotSerial;
    }
    const ccbSerial = parseQuoteSerialNumber(quote?.quoteNumber, 'cuenta_cobro');
    if (ccbSerial > maxCuentaCobro) {
      maxCuentaCobro = ccbSerial;
    }
  }

  const nextCotizacion = Math.max(serials.cotizacion.next, maxCotizacion + 1);
  const nextCuentaCobro = Math.max(serials.cuenta_cobro.next, maxCuentaCobro + 1);
  const changed = nextCotizacion !== serials.cotizacion.next || nextCuentaCobro !== serials.cuenta_cobro.next;

  if (changed) {
    const nextState = {
      ...serials,
      cotizacion: {
        next: nextCotizacion
      },
      cuenta_cobro: {
        next: nextCuentaCobro
      }
    };
    writeQuoteSerials(nextState);
    return nextState;
  }

  return serials;
}

function reserveNextQuoteSerialNumber(source, quotesInput = null) {
  const kind = quoteSerialKindFromSource(source);
  if (!kind) {
    return '';
  }

  const quotes = Array.isArray(quotesInput)
    ? normalizeQuotes(quotesInput)
    : normalizeQuotes(readJson(QUOTES_FILE, defaultQuotes()).quotes);
  const serials = ensureQuoteSerialState(quotes);
  const usedNumbers = new Set(
    quotes
      .map((item) => sanitizeText(item?.quoteNumber, 60).toUpperCase())
      .filter(Boolean)
  );
  let cursor = serials[kind].next;
  let nextNumber = formatQuoteSerialNumber(kind, cursor);

  while (usedNumbers.has(nextNumber)) {
    cursor += 1;
    nextNumber = formatQuoteSerialNumber(kind, cursor);
  }

  const nextState = {
    ...serials,
    [kind]: {
      next: cursor + 1
    }
  };
  writeQuoteSerials(nextState);

  return nextNumber;
}

function sanitizeImageDataUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(clean)) {
    return '';
  }
  return clean.length <= 420_000 ? clean : '';
}

function sanitizeAccountAttachmentDataUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(clean)) {
    return '';
  }
  return clean.length <= 780_000 ? clean : '';
}

function parseNonNegativeFloat(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return roundTwo(parsed);
}

function calculatorModeLabelFromKey(mode) {
  const map = {
    fdm: 'FDM',
    resina: 'Resina',
    moldes: 'Moldes',
    diseno: 'Diseno'
  };
  return map[String(mode || '').trim().toLowerCase()] || 'General';
}

function normalizeCalculatorMeta(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const mode = sanitizeText(value.mode, 20).toLowerCase();
  const modeLabel = sanitizeText(value.modeLabel, 40) || calculatorModeLabelFromKey(mode);
  const normalized = {
    mode,
    modeLabel,
    timeHours: parseNonNegativeFloat(value.timeHours),
    materialGrams: parseNonNegativeFloat(value.materialGrams),
    electricityCost: parseMoney(value.electricityCost),
    operatorPay: parseMoney(value.operatorPay),
    materialCost: parseMoney(value.materialCost),
    totalCost: parseMoney(value.totalCost),
    commercialValue: parseMoney(value.commercialValue),
    finalValue: parseMoney(value.finalValue),
    materialLabel: sanitizeText(value.materialLabel, 60),
    colorLabel: sanitizeText(value.colorLabel, 60),
    machineLabel: sanitizeText(value.machineLabel, 60)
  };

  if (!normalized.mode && normalized.totalCost <= 0 && normalized.finalValue <= 0) {
    return null;
  }

  return normalized;
}

function addHoursToIso(isoDate, hours) {
  const parsed = new Date(String(isoDate || '')).getTime();
  const base = Number.isNaN(parsed) ? Date.now() : parsed;
  return new Date(base + Math.round(Number(hours || 0) * 60 * 60 * 1000)).toISOString();
}

function syncClientFromQuote(quote) {
  if (isQuoteDeletedRecord(quote)) {
    return { synced: false, clients: null, message: '' };
  }
  const source = normalizeRecordSource(quote?.source, inferQuoteSource(quote?.quoteNumber, quote?.notes));
  if (source !== 'calculadora') {
    return { synced: false, clients: null, message: '' };
  }
  if (quote?.syncClient === false) {
    return { synced: false, clients: null, message: '' };
  }

  const quoteId = sanitizeText(quote?.id, 40);
  const quoteRef = sanitizeText(quote?.quoteNumber, 60);
  if (!quoteRef) {
    return { synced: false, clients: null, message: 'Referencia de cotizacion no valida' };
  }

  const calculatorMeta = normalizeCalculatorMeta(quote?.calculatorMeta);
  const primaryConcept = sanitizeText(quote?.items?.[0]?.concept, 120) || 'Trabajo calculado';
  const dueAtBase = resolveDueDateFromBody(quote?.quoteDate) || new Date().toISOString();
  const dueAt = addHoursToIso(dueAtBase, 72);
  const electricityCost = parseMoney(calculatorMeta?.electricityCost);
  const operatorPay = parseMoney(calculatorMeta?.operatorPay);
  const materialCost = parseMoney(calculatorMeta?.materialCost);
  const costValue = parseMoney(
    calculatorMeta?.totalCost
    || quote?.grossTotal
    || (electricityCost + operatorPay + materialCost)
  );

  const raw = readJson(CLIENTS_FILE, { clients: [] });
  const clients = normalizeClients(raw.clients);
  const quoteIdLower = quoteId.toLowerCase();
  const quoteRefLower = quoteRef.toLowerCase();
  let existingIndex = -1;
  if (quoteIdLower) {
    existingIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === 'calculadora'
        && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
    );
  }
  if (existingIndex < 0) {
    existingIndex = clients.findIndex(
      (item) =>
        normalizeRecordSource(item.source, 'manual') === 'calculadora'
        && (
          !String(item.quoteId || '').trim()
          || String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        )
        && String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
    );
  }

  if (existingIndex >= 0) {
    const current = clients[existingIndex];
    const keepStatus = normalizeStatus(current.status);
    clients[existingIndex] = {
      ...current,
      client: sanitizeText(quote?.clientName, 80) || current.client || 'Sin cliente',
      product: primaryConcept,
      machine: sanitizeText(calculatorMeta?.machineLabel, 60) || current.machine || 'Sin asignar',
      source: 'calculadora',
      quoteId,
      quoteRef,
      quotedValue: parseMoney(quote?.netTotal || 0),
      saleValue: parseMoney(current.saleValue),
      costValue,
      electricityCost,
      operatorPay,
      materialCost,
      dueAt: resolveDueDateFromBody(current.dueAt) || dueAt,
      status: keepStatus === 'quoted' ? 'quoted' : keepStatus,
      createdAt: resolveDueDateFromBody(current.createdAt) || new Date().toISOString()
    };

    const normalized = normalizeClients(clients);
    writeJson(CLIENTS_FILE, { clients: normalized });
    return {
      synced: true,
      clients: normalized,
      message: 'Cliente actualizado desde cotizacion de calculadora'
    };
  }

  clients.push({
    id: generateClientId(),
    client: sanitizeText(quote?.clientName, 80) || 'Sin cliente',
    product: primaryConcept,
    machine: sanitizeText(calculatorMeta?.machineLabel, 60) || 'Sin asignar',
    source: 'calculadora',
    quoteId,
    quoteRef,
    status: 'quoted',
    quotedValue: parseMoney(quote?.netTotal || 0),
    saleValue: 0,
    costValue,
    electricityCost,
    operatorPay,
    materialCost,
    dueAt,
    createdAt: new Date().toISOString()
  });

  const normalized = normalizeClients(clients);
  writeJson(CLIENTS_FILE, { clients: normalized });
  return {
    synced: true,
    clients: normalized,
    message: 'Cliente creado desde cotizacion de calculadora'
  };
}

function backfillClientsFromCalculatorQuotes() {
  try {
    const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
    const quotes = normalizeQuotes(quotesRaw.quotes);
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return;
    }

    const calculatorQuotes = quotes.filter(
      (quote) => normalizeRecordSource(quote.source, '') === 'calculadora' && !isQuoteDeletedRecord(quote)
    );
    if (calculatorQuotes.length === 0) {
      return;
    }

    let recovered = 0;
    for (const quote of calculatorQuotes) {
      const result = syncClientFromQuote(quote);
      if (result.synced) {
        recovered += 1;
      }
    }

    if (recovered > 0) {
      console.log(`[startup] Clientes sincronizados desde cotizaciones de calculadora: ${recovered}`);
    }

    const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
    const duplicateIdCount = countDuplicateClientIds(clientsRaw.clients);
    const repairedClients = normalizeClients(clientsRaw.clients);
    writeJson(CLIENTS_FILE, { clients: repairedClients });
    if (duplicateIdCount > 0) {
      console.log(`[startup] IDs de clientes reparados (duplicados): ${duplicateIdCount}`);
    }
  } catch (error) {
    console.error('[startup] Error sincronizando clientes desde cotizaciones:', error);
  }
}

function backfillQuoteLinksAndApprovedTasks() {
  try {
    const quotesRaw = readJson(QUOTES_FILE, defaultQuotes());
    const quotes = normalizeQuotes(quotesRaw.quotes);
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return;
    }

    const clientsRaw = readJson(CLIENTS_FILE, { clients: [] });
    const clients = normalizeClients(clientsRaw.clients);
    const tasksRaw = readJson(TASKS_FILE, defaultTasks());
    const tasks = normalizeTasks(tasksRaw.tasks);

    const uniqueQuoteBySourceRef = new Map();
    for (const quote of quotes) {
      if (isQuoteDeletedRecord(quote)) {
        continue;
      }
      const source = normalizeRecordSource(quote.source, inferQuoteSource(quote.quoteNumber, quote.notes));
      if (source === 'cuenta_cobro') {
        continue;
      }

      const approvalSource = source === 'calculadora' ? 'calculadora' : 'cotizacion';
      const quoteRef = sanitizeText(quote.quoteNumber, 60).toLowerCase();
      if (!quoteRef) {
        continue;
      }

      const key = `${approvalSource}|${quoteRef}`;
      if (!uniqueQuoteBySourceRef.has(key)) {
        uniqueQuoteBySourceRef.set(key, quote);
      } else {
        uniqueQuoteBySourceRef.set(key, null);
      }
    }

    let clientsChanged = false;
    for (const client of clients) {
      if (sanitizeText(client.quoteId, 40)) {
        continue;
      }

      const quoteRef = sanitizeText(client.quoteRef, 80).toLowerCase();
      if (!quoteRef) {
        continue;
      }
      const source = normalizeRecordSource(client.source, 'manual');
      const key = `${source === 'calculadora' ? 'calculadora' : 'cotizacion'}|${quoteRef}`;
      const match = uniqueQuoteBySourceRef.get(key);
      if (!match || !sanitizeText(match.id, 40)) {
        continue;
      }

      client.quoteId = sanitizeText(match.id, 40);
      clientsChanged = true;
    }

    let tasksChanged = false;
    for (const task of tasks) {
      if (sanitizeText(task.quoteId, 40)) {
        continue;
      }

      const quoteRef = sanitizeText(task.quoteRef, 80).toLowerCase();
      if (!quoteRef) {
        continue;
      }
      const source = normalizeTaskSource(task.source);
      const key = `${source === 'calculadora' ? 'calculadora' : 'cotizacion'}|${quoteRef}`;
      const match = uniqueQuoteBySourceRef.get(key);
      if (!match || !sanitizeText(match.id, 40)) {
        continue;
      }

      task.quoteId = sanitizeText(match.id, 40);
      tasksChanged = true;
    }

    let quotesChanged = false;
    let recoveredTasks = 0;
    for (let index = 0; index < quotes.length; index += 1) {
      const quote = quotes[index];
      if (isQuoteDeletedRecord(quote)) {
        continue;
      }
      const source = normalizeRecordSource(quote.source, inferQuoteSource(quote.quoteNumber, quote.notes));
      if (source === 'cuenta_cobro') {
        continue;
      }

      const approvedAt = resolveDueDateFromBody(quote.approvedAt);
      if (!approvedAt) {
        continue;
      }

      const approvalSource = source === 'calculadora' ? 'calculadora' : 'cotizacion';
      const quoteId = sanitizeText(quote.id, 40);
      const quoteIdLower = quoteId.toLowerCase();
      const quoteRef = sanitizeText(quote.quoteNumber, 60);
      const quoteRefLower = quoteRef.toLowerCase();

      let linkedClient = null;
      const preferredClientId = sanitizeText(quote.approvedClientId, 40);
      if (preferredClientId) {
        linkedClient = clients.find((item) => item.id === preferredClientId) || null;
      }
      if (!linkedClient && quoteIdLower) {
        linkedClient = clients.find(
          (item) =>
            normalizeRecordSource(item.source, 'manual') === approvalSource
            && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) || null;
      }
      if (!linkedClient && quoteRefLower) {
        linkedClient = clients.find(
          (item) =>
            normalizeRecordSource(item.source, 'manual') === approvalSource
            && String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
        ) || null;
      }

      if (linkedClient && sanitizeText(quote.approvedClientId, 40) !== linkedClient.id) {
        quotes[index] = {
          ...quotes[index],
          approvedClientId: linkedClient.id
        };
        quotesChanged = true;
      }

      let linkedTask = null;
      const preferredTaskId = sanitizeText(quote.approvedTaskId, 40);
      if (preferredTaskId) {
        linkedTask = tasks.find((item) => item.id === preferredTaskId) || null;
      }
      if (!linkedTask && quoteIdLower) {
        linkedTask = tasks.find(
          (item) =>
            item.kind === 'impresion'
            && normalizeTaskSource(item.source) === approvalSource
            && String(item.quoteId || '').trim().toLowerCase() === quoteIdLower
        ) || null;
      }
      if (!linkedTask && quoteRefLower) {
        linkedTask = tasks.find(
          (item) =>
            item.kind === 'impresion'
            && normalizeTaskSource(item.source) === approvalSource
            && String(item.quoteRef || '').trim().toLowerCase() === quoteRefLower
        ) || null;
      }

      const now = new Date().toISOString();
      const dueAtBase = linkedClient?.dueAt || quote.quoteDate || now;
      const dueAt = resolveDueDateFromBody(dueAtBase) || addHoursToIso(now, 72);
      if (!linkedTask) {
        const taskTitle = buildQuotePrintTaskTitle(quote);
        const taskNotes = `Generada al aprobar cotizacion ${quoteRef}.`;
        const taskDetails = buildQuotePrintTaskDetails(quote);
        const newTask = {
          id: generateTaskId(),
          kind: 'impresion',
          source: approvalSource,
          quoteId,
          quoteRef,
          client: sanitizeText(quote.clientName, 80) || 'Sin cliente',
          title: taskTitle,
          notes: taskNotes,
          details: taskDetails,
          dueAt,
          status: 'pending',
          createdAt: now
        };
        tasks.push(newTask);
        linkedTask = newTask;
        tasksChanged = true;
        recoveredTasks += 1;
      } else if (!sanitizeText(linkedTask.quoteId, 40) && quoteId) {
        linkedTask.quoteId = quoteId;
        tasksChanged = true;
      }

      if (linkedTask && sanitizeText(quote.approvedTaskId, 40) !== linkedTask.id) {
        quotes[index] = {
          ...quotes[index],
          approvedTaskId: linkedTask.id
        };
        quotesChanged = true;
      }
    }

    if (clientsChanged) {
      writeJson(CLIENTS_FILE, { clients: normalizeClients(clients) });
    }
    if (tasksChanged) {
      writeJson(TASKS_FILE, { tasks: normalizeTasks(tasks) });
    }
    if (quotesChanged) {
      writeJson(QUOTES_FILE, { quotes: normalizeQuotes(quotes) });
    }

    if (clientsChanged || tasksChanged || quotesChanged) {
      console.log(
        `[startup] Enlaces de cotizaciones reparados: clientes=${clientsChanged ? 'si' : 'no'}, tareas=${tasksChanged ? 'si' : 'no'}, cotizaciones=${quotesChanged ? 'si' : 'no'}`
      );
    }
    if (recoveredTasks > 0) {
      console.log(`[startup] Tareas de impresion recuperadas desde aprobaciones: ${recoveredTasks}`);
    }
  } catch (error) {
    console.error('[startup] Error reparando enlaces de cotizaciones/tareas:', error);
  }
}

function countDuplicateClientIds(items) {
  const seen = new Set();
  let duplicates = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const id = sanitizeText(item?.id, 40);
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
  }
  return duplicates;
}

function parseMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.round(parsed);
}

function parseCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.round(parsed);
}

function parsePct(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return roundTwo(parsed);
}

function parseGrams(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return NaN;
  }
  return roundTwo(parsed);
}

function roundTwo(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sanitizeText(value, maxLength) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  return clean.slice(0, maxLength);
}

function sanitizeMultilineText(value, maxLength) {
  const clean = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim();
  return clean.slice(0, maxLength);
}

function normalizeClientProfileNameKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function monthLabel(dateValue) {
  return new Intl.DateTimeFormat('es-CO', { month: 'short' })
    .format(dateValue)
    .replace('.', '')
    .slice(0, 3)
    .toUpperCase();
}

function normalizePathname(pathname) {
  const value = String(pathname || '/');
  if (value === '/') {
    return '/';
  }
  return value.replace(/\/+$/, '');
}

function generateOrderId() {
  return `IMP-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateClientId() {
  return `CLI-${Date.now().toString().slice(-7)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateClientProfileId() {
  return `CPF-${Date.now().toString().slice(-7)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateQuoteId() {
  return `COT-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateTaskId() {
  return `TSK-${Date.now().toString().slice(-7)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateCalculatorHistoryId() {
  return `HIS-${Date.now().toString().slice(-7)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateAccountEntryId() {
  return `ACC-${Date.now().toString().slice(-7)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function serveStatic(pathname, res) {
  // Determine which file to serve
  let requestedPath = pathname.replace(/^\/+/, '');
  if (!requestedPath || requestedPath === 'index.html') {
    requestedPath = 'index.html';          // React landing page (physically in public/)
  } else if (pathname === '/panel' || pathname === '/panel/' || pathname === '/app') {
    requestedPath = 'panel.html';          // Old ops panel
  } else if (pathname === '/manipulador' || pathname === '/manipulador/') {
    requestedPath = 'manipulator.html';    // Panel control manipulador lineal
  }

  const normalizedPath = path.normalize(requestedPath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(publicRoot, normalizedPath);
  const relativePath = path.relative(publicRoot, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return sendJson(res, 403, { ok: false, message: 'Acceso denegado' });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { ok: false, message: 'Archivo no encontrado' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType
  };

  if (ext === '.html') {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers.Pragma = 'no-cache';
    headers.Expires = '0';
  } else if (ext === '.js' || ext === '.css') {
    headers['Cache-Control'] = 'no-cache, must-revalidate';
  }

  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      data += chunk;
      if (data.length > 1_000_000) {
        done = true;
        req.destroy();
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (_error) {
        reject(new Error('JSON invalido'));
      }
    });

    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  }).catch(() => ({}));
}

function ensureSeedFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(USERS_FILE)) {
    writeJson(USERS_FILE, {
      users: [
        {
          email: 'moulecolombia@gmail.com',
          name: 'Administrador Moule',
          role: 'admin',
          active: true,
          salt: '368308f3ba134570a60e5304cdc72a82',
          passwordHash: '0a45f8d0996526a8ff8c3f12e8e776558461990f9779135ec8a4304d8e7c3687'
        }
      ]
    });
  }

  if (!fs.existsSync(DASHBOARD_FILE)) {
    writeJson(DASHBOARD_FILE, defaultDashboard());
  }

  if (!fs.existsSync(STOCK_FILE)) {
    writeJson(STOCK_FILE, defaultStock());
  }

  if (!fs.existsSync(CLIENTS_FILE)) {
    writeJson(CLIENTS_FILE, { clients: [] });
  }

  if (!fs.existsSync(CLIENT_PROFILES_FILE)) {
    writeJson(CLIENT_PROFILES_FILE, defaultClientProfiles());
  }

  if (!fs.existsSync(QUOTES_FILE)) {
    writeJson(QUOTES_FILE, defaultQuotes());
  }
  if (!fs.existsSync(QUOTE_SERIALS_FILE)) {
    writeJson(QUOTE_SERIALS_FILE, defaultQuoteSerials());
  }

  if (!fs.existsSync(TASKS_FILE)) {
    writeJson(TASKS_FILE, defaultTasks());
  }

  if (!fs.existsSync(PRINTERS_FILE)) {
    writeJson(PRINTERS_FILE, defaultPrinters());
  }

  if (!fs.existsSync(CALCULATOR_HISTORY_FILE)) {
    writeJson(CALCULATOR_HISTORY_FILE, defaultCalculatorHistory());
  }

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    writeJson(ACCOUNTS_FILE, defaultAccounts());
  }
}

function defaultDashboard() {
  return {
    currency: 'COP',
    salesSummary: {
      monthLabel: monthLabel(new Date()),
      monthlyTotal: 0,
      monthlyGoal: 0,
      netBalance: 0,
      completedOrders: 0,
      pendingOrders: 0,
      marginPct: 0
    },
    monthlyRevenue: defaultMonthlyRevenue(),
    orders: []
  };
}

function defaultMonthlyRevenue() {
  const result = [];
  const now = new Date();

  for (let idx = 5; idx >= 0; idx -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - idx, 1);
    result.push({
      month: monthLabel(date),
      value: 0
    });
  }

  return result;
}

function defaultStock() {
  return {
    items: []
  };
}

function defaultClientProfiles() {
  return {
    profiles: []
  };
}

function defaultQuotes() {
  return {
    quotes: []
  };
}

function defaultQuoteSerials() {
  return {
    cotizacion: {
      next: 1
    },
    cuenta_cobro: {
      next: 1
    },
    updatedAt: new Date().toISOString()
  };
}

function defaultTasks() {
  return {
    tasks: []
  };
}

function defaultPrinters() {
  const now = new Date().toISOString();
  return {
    printers: [
      {
        id: 'k1_max',
        name: 'K1 Max',
        type: 'fdm',
        status: 'libre',
        material: '',
        currentJob: '',
        notes: '',
        updatedAt: now
      },
      {
        id: 'kobra_max',
        name: 'Kobra Max',
        type: 'fdm',
        status: 'libre',
        material: '',
        currentJob: '',
        notes: '',
        updatedAt: now
      },
      {
        id: 'mono_m5s_1',
        name: 'Mono M5s #1',
        type: 'resina',
        status: 'libre',
        material: '',
        currentJob: '',
        notes: '',
        updatedAt: now
      },
      {
        id: 'mono_m5s_2',
        name: 'Mono M5s #2',
        type: 'resina',
        status: 'libre',
        material: '',
        currentJob: '',
        notes: '',
        updatedAt: now
      }
    ]
  };
}

function defaultCalculatorHistory() {
  return {
    entries: []
  };
}

function defaultAccounts() {
  return {
    entries: [],
    payables: {
      deudaPendiente: 0,
      updatedAt: new Date().toISOString()
    }
  };
}

function readJson(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// ── WhatsApp alert system (Twilio) ──────────────────────────────────────────

function readAlertState() {
  try {
    const raw = fs.readFileSync(ALERT_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { sentWarning: {}, sentCritical: {} };
  }
}

function writeAlertState(state) {
  try {
    fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

function formatDueDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleString('es-CO', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function buildWhatsAppMessage(orders, level) {
  const emoji = level === 'critica' ? '🔴' : '🟡';
  const levelText = level === 'critica' ? 'CRÍTICA' : 'Advertencia';
  const lines = orders.map(o => {
    const timeText = o.minutesLeft <= 0
      ? '⚠️ VENCIDA'
      : `⏱ ${Math.floor(o.minutesLeft / 60)}h ${o.minutesLeft % 60}min`;
    return `• *${o.client}* — ${o.product}\n  ${timeText} (entrega: ${formatDueDate(o.dueAt)})`;
  });
  return `${emoji} *Moule 3D — Alerta ${levelText}*\n\n${lines.join('\n\n')}\n\n_Panel: localhost:3000/panel_`;
}

async function sendWhatsAppAlert(orders, level) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_FROM || WA_RECIPIENTS.length === 0) return;
  const client = twilio(TWILIO_SID, TWILIO_TOKEN);
  const body = buildWhatsAppMessage(orders, level);
  for (const to of WA_RECIPIENTS) {
    try {
      await client.messages.create({ from: TWILIO_WA_FROM, to, body });
      console.log(`[alerts] WhatsApp ${level} enviado a ${to}: ${orders.map(o => o.client).join(', ')}`);
    } catch (err) {
      console.error(`[alerts] Error enviando WhatsApp a ${to}:`, err.message);
    }
  }
}

async function checkAndSendAlerts() {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_FROM || WA_RECIPIENTS.length === 0) return;

  const clients = readJson(CLIENTS_FILE, { clients: [] }).clients || [];
  const now = Date.now();
  const state = readAlertState();
  const newWarning = [];
  const newCritical = [];

  for (const item of clients) {
    if (['delivered', 'cancelled', 'quoted'].includes(item.status)) continue;
    if (!item.dueAt) continue;
    const dueAt = new Date(item.dueAt).getTime();
    const minutesLeft = Math.round((dueAt - now) / 60000);
    const key = item.id || `${item.client}-${item.dueAt}`;
    const order = { client: item.client, product: item.product, dueAt: item.dueAt, minutesLeft };

    if (minutesLeft <= ALERT_THRESHOLD_CRITICAL_MIN && !state.sentCritical[key]) {
      newCritical.push(order);
      state.sentCritical[key] = now;
    } else if (minutesLeft <= ALERT_THRESHOLD_WARNING_MIN && !state.sentWarning[key]) {
      newWarning.push(order);
      state.sentWarning[key] = now;
    }
  }

  // Limpiar entradas viejas (más de 7 días)
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(state.sentWarning)) {
    if (state.sentWarning[key] < cutoff) delete state.sentWarning[key];
  }
  for (const key of Object.keys(state.sentCritical)) {
    if (state.sentCritical[key] < cutoff) delete state.sentCritical[key];
  }

  if (newCritical.length > 0) await sendWhatsAppAlert(newCritical, 'critica');
  if (newWarning.length > 0) await sendWhatsAppAlert(newWarning, 'advertencia');

  writeAlertState(state);
}

function startAlertScheduler() {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_WA_FROM || WA_RECIPIENTS.length === 0) {
    console.warn('[alerts] Twilio no configurado. Alertas de WhatsApp desactivadas. Configura TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM, WA_RECIPIENT_1 en .env');
    return;
  }
  console.log(`[alerts] Scheduler WhatsApp iniciado (cada 15 min) → ${WA_RECIPIENTS.join(', ')}`);
  checkAndSendAlerts();
  setInterval(checkAndSendAlerts, ALERT_CHECK_INTERVAL_MS);
}
