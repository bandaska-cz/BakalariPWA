/* ==========================================================================
   ŠKOLNÍ PARŤÁK (BAKALÁŘI PWA) - LOKÁLNÍ SERVER & CORS PROXY
   Spuštění: node proxy-server.js
   Aplikace následně běží na: http://localhost:3000
   ========================================================================== */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedReqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept'
    });
    res.end();
    return;
  }

  // 2. Bakaláři API v3 CORS Proxy endpoint: /proxy?url=https://...
  if (parsedReqUrl.pathname === '/proxy') {
    const targetUrlStr = parsedReqUrl.searchParams.get('url');
    if (!targetUrlStr) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Chybí parametr ?url=' }));
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Neplatná cílová URL adresa.' }));
      return;
    }

    const client = targetUrl.protocol === 'https:' ? https : http;
    const headers = {};
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['accept']) headers['Accept'] = req.headers['accept'];
    headers['User-Agent'] = 'BakalariPWA/1.0 (Android)';

    const proxyReq = client.request(
      targetUrl,
      {
        method: req.method,
        headers
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'Chyba spojení se školním serverem Bakaláři', detail: err.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  // 3. Static PWA File Server
  let safePath = path.normalize(decodeURIComponent(parsedReqUrl.pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Soubor nenalezen');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log('============================================================');
  console.log(`🦉 Školní parťák (Bakaláři PWA) běží na: http://localhost:${PORT}`);
  console.log(`🔌 Lokální CORS Proxy pro Bakaláři API:  http://localhost:${PORT}/proxy?url=...`);
  console.log('============================================================');
});

