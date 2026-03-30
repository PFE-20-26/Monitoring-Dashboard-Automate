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
let stopStartTime = null;     // Date.now() when the stop started
let currentSens = 'ENROULEMENT'; // 'ENROULEMENT' | 'DEROULEMENT'
let stopTriggeredBySens = false; // true if stop was triggered by sens change

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

// ── State snapshot helper ─────────────────────────────────
function stateSnapshot() {
  return { isStopped, pendingCause, stopStartTime, currentSens, stopTriggeredBySens };
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
    res.end(JSON.stringify(stateSnapshot()));
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
  if (req.method === 'POST' && req.url === '/start-stop') {
    try {
      await callNodeRed('/plc-set-m0', { value: 1 });

      isStopped = true;
      pendingCause = null;
      stopStartTime = Date.now();
      stopTriggeredBySens = false;

      console.log('▶ ARRÊT démarré (bouton)');
      res.writeHead(200);
      res.end(JSON.stringify(stateSnapshot()));
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
  if (req.method === 'POST' && req.url === '/end-stop') {
    const body = await parseBody(req);
    const causeId = Number(body.causeId) || 16;
    const causeName = body.causeName || 'Arrêt non considéré';

    try {
      // 1. Write cause M bit ON so ISPSoft ladder writes D30 = cause_id
      if (causeId !== 16) {
        await callNodeRed('/plc-set-cause', {
          address: causeAddress(causeId),
          value: 1,
        });
      }

      // 2. Turn M0 OFF → machine restarts
      await callNodeRed('/plc-set-m0', { value: 0 });

      // 3. Clean up the cause M bit after a short delay
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
      stopTriggeredBySens = false;

      console.log(`⏹ ARRÊT terminé | cause_id=${causeId} (${causeName})`);
      res.writeHead(200);
      res.end(JSON.stringify(stateSnapshot()));
    } catch (err) {
      console.error('Node-RED error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Node-RED injoignable: ' + err.message }));
    }
    return;
  }

  // ── POST /set-sens ─────────────────────────────────────
  // Called when sens button is clicked.
  // body: { sens: 'ENROULEMENT' | 'DEROULEMENT' }
  //
  // DEROULEMENT → if machine is running, trigger a stop (set M0=1)
  //               Machine stays stopped until ENROULEMENT is selected.
  // ENROULEMENT → if stop was triggered by sens change, show cause overlay
  //               to let operator select a cause then resume (set M0=0).
  //               If machine is already running, just update sens label.
  if (req.method === 'POST' && req.url === '/set-sens') {
    const body = await parseBody(req);
    const newSens = body.sens === 'DEROULEMENT' ? 'DEROULEMENT' : 'ENROULEMENT';
    const prevSens = currentSens;
    currentSens = newSens;

    try {
      if (newSens === 'DEROULEMENT' && !isStopped) {
        // Trigger a stop
        await callNodeRed('/plc-set-m0', { value: 1 });
        isStopped = true;
        pendingCause = null;
        stopStartTime = Date.now();
        stopTriggeredBySens = true;
        console.log('▶ ARRÊT démarré (sens → DÉROULEMENT)');
      } else if (newSens === 'ENROULEMENT' && isStopped && stopTriggeredBySens) {
        // Signal to client that it should show the cause overlay
        // The actual M0=0 write happens in /end-stop after cause is selected
        console.log('⟵ Retour ENROULEMENT — attente sélection cause');
      }
      // Other cases: sens change while already stopped or already running → just update label

      res.writeHead(200);
      res.end(JSON.stringify(stateSnapshot()));
    } catch (err) {
      // Roll back sens if PLC write failed
      currentSens = prevSens;
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