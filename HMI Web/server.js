const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// ─── CONFIG ───────────────────────────────────────────────
const WEB_PORT = 3000;

const DB = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'isetiset2023',
  database: 'dashboard',
});
// ──────────────────────────────────────────────────────────

// ── DB helper ─────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) =>
    DB.execute(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

// ─── HTTP Server ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(WEB_PORT, () => {
  console.log(`✅ Web server  → http://localhost:${WEB_PORT}`);
});

// Test DB connection at startup
DB.getConnection((err, conn) => {
  if (err) console.error('❌ MySQL:', err.message);
  else { console.log('✅ MySQL connecté'); conn.release(); }
});