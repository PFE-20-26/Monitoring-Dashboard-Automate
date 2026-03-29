const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// ─── CONFIG ───────────────────────────────────────────────
const WEB_PORT = 3000;
const NR_HOST = 'localhost';
const NR_PORT = 1880;

const DB = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'isetiset2023',
  database: 'dashboard',
});
// ──────────────────────────────────────────────────────────

// M bit mapping : cause_id → Modbus coil address
// cause 1 → M10 = 2058,  cause 2 → M11 = 2059 ... etc.
const CAUSE_M_BASE = 2058; // M10
function causeAddress(causeId) {
  return CAUSE_M_BASE + (Number(causeId) - 1);
}

// ── State ─────────────────────────────────────────────────
let isStopped = false;
let pendingCause = null;      // { id, name } — only set once cause is chosen
let stopStartTime = null;      // Date.now() when the stop started

// ── Call Node-RED HTTP endpoint ───────────────────────────
function callNodeRed(endpointPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: NR_HOST,
      port: NR_PORT,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── DB helper ─────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) =>
    DB.execute(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

// ── Body parser ───────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// ─── HTTP Server ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve index.html ───────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(html);
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  // ── GET /status ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({
      isStopped,
      pendingCause,
      stopStartTime,  // epoch ms — client calculates elapsed duration
    }));
    return;
  }

  // ── GET /causes → MySQL ────────────────────────────────
  if (req.method === 'GET' && req.url === '/causes') {
    try {
      const rows = await dbQuery(
        'SELECT id, name FROM causes WHERE is_active = 1 AND id != 16 ORDER BY id'
      );
      res.writeHead(200);
      res.end(JSON.stringify(rows));
    } catch (e) {
      console.error('MySQL /causes error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Erreur DB: ' + e.message }));
    }
    return;
  }

  // ── POST /start-stop ───────────────────────────────────
  // Called when MARCHE is pressed and machine is RUNNING → start a stop.
  // No cause needed yet — just set M0 ON and record start time.
  if (req.method === 'POST' && req.url === '/start-stop') {
    try {
      await callNodeRed('/plc-set-m0', { value: 1 });

      isStopped = true;
      pendingCause = null;
      stopStartTime = Date.now();

      console.log('▶ ARRÊT démarré');
      res.writeHead(200);
      res.end(JSON.stringify({ isStopped, pendingCause, stopStartTime }));
    } catch (err) {
      console.error('Node-RED error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Node-RED injoignable: ' + err.message }));
    }
    return;
  }

  // ── POST /end-stop ─────────────────────────────────────
  // Called when MARCHE is pressed and machine is STOPPED → end the stop.
  // body: { causeId: number, causeName: string }
  // causeId=16 is sent automatically for micro-stops (<30s) — the DB trigger
  // also enforces this independently.
  if (req.method === 'POST' && req.url === '/end-stop') {
    const body = await parseBody(req);
    const causeId = Number(body.causeId) || 16;
    const causeName = body.causeName || 'Arrêt non considéré';

    try {
      // 1. Write the cause M bit ON so ISPSoft ladder writes D30 = cause_id
      //    (only meaningful for causes 1-15; cause 16 is handled by DB trigger)
      if (causeId !== 16) {
        await callNodeRed('/plc-set-cause', {
          address: causeAddress(causeId),
          value: 1,
        });
      }

      // 2. Turn M0 OFF → machine restarts, ladder captures stop time → D20,
      //    sets stopReady (M1) → Node-RED reads D10-D30 → INSERT into MySQL
      await callNodeRed('/plc-set-m0', { value: 0 });

      // 3. Clean up the cause M bit after a short delay
      //    (Network 5 timer resets them, but also clean from server side)
      if (causeId !== 16) {
        setTimeout(async () => {
          try {
            await callNodeRed('/plc-set-cause', {
              address: causeAddress(causeId),
              value: 0,
            });
          } catch { }
        }, 3000);
      }

      pendingCause = { id: causeId, name: causeName };
      isStopped = false;
      stopStartTime = null;

      console.log(`⏹ ARRÊT terminé | cause_id=${causeId} (${causeName})`);
      res.writeHead(200);
      res.end(JSON.stringify({ isStopped, pendingCause, stopStartTime }));
    } catch (err) {
      console.error('Node-RED error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Node-RED injoignable: ' + err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(WEB_PORT, () => {
  console.log(`✅ Web server  → http://localhost:${WEB_PORT}`);
  console.log(`📡 Node-RED    → http://${NR_HOST}:${NR_PORT}`);
});

// Test DB connection at startup
DB.getConnection((err, conn) => {
  if (err) console.error('❌ MySQL:', err.message);
  else { console.log('✅ MySQL connecté'); conn.release(); }
});