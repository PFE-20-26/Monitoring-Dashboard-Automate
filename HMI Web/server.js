const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const mysql = require('mysql2');

// ─── CONFIG ───────────────────────────────────────────────
const WEB_PORT = 3000;
const NR_HOST  = 'localhost';
const NR_PORT  = 1880;

const DB = mysql.createPool({
  host    : '127.0.0.1',
  port    : 3306,
  user    : 'root',
  password: 'isetiset2023',
  database: 'dashboard',
});
// ──────────────────────────────────────────────────────────

// M bit mapping : cause_id → Modbus coil address
// cause 1 → M10 = 2058
// cause 2 → M11 = 2059  ...etc
const CAUSE_M_BASE = 2058; // M10
function causeAddress(causeId) {
  return CAUSE_M_BASE + (Number(causeId) - 1);
}

let isStopped    = false;
let pendingCause = { id: 1, name: 'Panne machine' };

// ── Call Node-RED HTTP endpoint ───────────────────────────
function callNodeRed(endpointPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: NR_HOST,
      port    : NR_PORT,
      path    : endpointPath,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
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

  // ── Serve index.html ──────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(html);
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  // ── GET /status ──────────────────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ isStopped, pendingCause }));
    return;
  }

  // ── GET /causes → depuis ta table MySQL ──────────────
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

  // ── POST /toggle ─────────────────────────────────────
  // body quand démarrage : { causeId: number, causeName: string }
  // body quand arrêt     : {}
  if (req.method === 'POST' && req.url === '/toggle') {
    const body = await parseBody(req);
    const next = !isStopped;

    try {
      if (next) {
        // ── DÉMARRER UN ARRÊT ────────────────────────
        const causeId   = Number(body.causeId)   || 1;
        const causeName = body.causeName          || 'Panne machine';
        pendingCause    = { id: causeId, name: causeName };

        // 1. Activer le M bit de la cause → ISPSoft écrit D30 = cause_id
        await callNodeRed('/plc-set-cause', {
          address: causeAddress(causeId),
          value  : 1,
        });

        // 2. Activer M0 → machine arrêtée
        await callNodeRed('/plc-set-m0', { value: 1 });

        console.log(`▶ ARRET démarré | cause_id=${causeId} (${causeName}) | M${9 + causeId}=ON | M0=ON`);

      } else {
        // ── TERMINER UN ARRÊT ────────────────────────

        // 1. Désactiver le M bit de la cause
        await callNodeRed('/plc-set-cause', {
          address: causeAddress(pendingCause.id),
          value  : 0,
        });

        // 2. Désactiver M0
        await callNodeRed('/plc-set-m0', { value: 0 });

        console.log(`⏹ ARRET terminé | cause_id=${pendingCause.id} | M${9 + pendingCause.id}=OFF | M0=OFF`);
      }

      isStopped = next;
      res.writeHead(200);
      res.end(JSON.stringify({ isStopped, pendingCause }));

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

// Test connexion DB au démarrage
DB.getConnection((err, conn) => {
  if (err) console.error('❌ MySQL:', err.message);
  else { console.log('✅ MySQL connecté'); conn.release(); }
});