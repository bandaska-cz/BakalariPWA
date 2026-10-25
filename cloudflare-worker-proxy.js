/* ==========================================================================
   CLOUDFLARE WORKER - MULTI-TENANT RODINNÁ SYNCHRONIZACE & ZABEZPEČENÁ PROXY
   Adresa vašeho Workeru: https://mute-cloud-b42b.radek-bunda.workers.dev

   Bezpečnostní prvky (v1.2.0):
   1. Multi-tenant izolace rodin pomocí Kódu rodiny (familyId -> FAMILY_V2_<ID>).
   2. Povinný 8+ znakový PIN ukládaný výhradně jako kryptografický SHA-256 otisk.
   3. Beznákladový Rate-Limiting v Cache API + Memory (5 chyb -> blokace IP na 15 min,
      nulová spotřeba denního limitu zápisů do Cloudflare KV).
   4. Uzamčená CORS Proxy: povoluje pouze dotazy z povolených Origin domén a pouze
      na Bakaláři API cesty (/api/ nebo /bakaweb/) s Anti-SSRF ochranou.
   ========================================================================== */

// In-memory fast cache inside worker isolate
const MEMORY_STORE = new Map();
const RATE_LIMIT_MEMORY = new Map();

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_PIN_LENGTH = 8;

// Allowed frontend origins for CORS Proxy & Family API
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/bandaska-cz\.github\.io$/i,
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i
];

function isOriginAllowed(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';

  if (!origin && !referer) {
    return false;
  }

  if (origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))) {
    return true;
  }

  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(refOrigin))) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowOrigin =
    origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
      ? origin
      : 'https://bandaska-cz.github.io';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Family-Pin, X-Family-Id',
    'Vary': 'Origin'
  };
}

function normalizeFamilyId(rawId) {
  const clean = String(rawId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  if (clean.length < 4 || clean.length > 24) {
    return null;
  }
  return clean;
}

async function hashPin(familyId, pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`BAKA_FAMILY_V2:${familyId}:${String(pin).trim()}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ==========================================================================
   ZERO-KV RATE LIMITING (Uses Isolate Memory + Cloudflare Cache API)
   Protects Cloudflare KV daily write quota against brute-force floods
   ========================================================================== */
function getClientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    'unknown-ip'
  );
}

async function getRateLimitState(ip) {
  const now = Date.now();
  const mem = RATE_LIMIT_MEMORY.get(ip);
  if (mem && mem.expiresAt > now) {
    return mem;
  }

  try {
    const cache = caches.default;
    const cacheUrl = `https://family-sync.internal/ratelimit/${encodeURIComponent(ip)}`;
    const cachedResp = await cache.match(cacheUrl);
    if (cachedResp) {
      const data = await cachedResp.json();
      if (data && data.expiresAt > now) {
        RATE_LIMIT_MEMORY.set(ip, data);
        return data;
      }
    }
  } catch (_) {}

  return { attempts: 0, expiresAt: now + LOCKOUT_MS };
}

async function saveRateLimitState(ip, state) {
  RATE_LIMIT_MEMORY.set(ip, state);
  try {
    const cache = caches.default;
    const cacheUrl = `https://family-sync.internal/ratelimit/${encodeURIComponent(ip)}`;
    const ttlSec = Math.max(60, Math.ceil((state.expiresAt - Date.now()) / 1000));
    const resp = new Response(JSON.stringify(state), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSec}`
      }
    });
    await cache.put(cacheUrl, resp);
  } catch (_) {}
}

async function clearRateLimitState(ip) {
  RATE_LIMIT_MEMORY.delete(ip);
  try {
    const cache = caches.default;
    const cacheUrl = `https://family-sync.internal/ratelimit/${encodeURIComponent(ip)}`;
    await cache.delete(cacheUrl);
  } catch (_) {}
}

/* ==========================================================================
   MULTI-TENANT FAMILY STORAGE (KV + Cache API + Memory)
   ========================================================================== */
function getStorageKeys(familyId) {
  return {
    kvKey: `FAMILY_V2_${familyId}`,
    cacheUrl: `https://family-sync.internal/v2/state/${encodeURIComponent(familyId)}`
  };
}

async function loadFamilyRecord(env, familyId) {
  const { kvKey, cacheUrl } = getStorageKeys(familyId);

  // 1. Try Cloudflare KV if bound as FAMILY_KV
  if (env && env.FAMILY_KV) {
    try {
      const kvData = await env.FAMILY_KV.get(kvKey, { type: 'json' });
      if (kvData) return kvData;
    } catch (_) {}
  }

  // 2. Try Worker Cache API
  try {
    const cache = caches.default;
    const cachedResp = await cache.match(cacheUrl);
    if (cachedResp) {
      return await cachedResp.json();
    }
  } catch (_) {}

  // 3. Fallback to isolate memory
  if (MEMORY_STORE.has(kvKey)) {
    return MEMORY_STORE.get(kvKey);
  }

  return null;
}

async function saveFamilyRecord(env, familyId, record) {
  const { kvKey, cacheUrl } = getStorageKeys(familyId);
  MEMORY_STORE.set(kvKey, record);

  // 1. Save to Cloudflare KV if bound
  if (env && env.FAMILY_KV) {
    try {
      await env.FAMILY_KV.put(kvKey, JSON.stringify(record));
    } catch (_) {}
  }

  // 2. Save to Cloudflare Cache API
  try {
    const cache = caches.default;
    const resp = new Response(JSON.stringify(record), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000'
      }
    });
    await cache.put(cacheUrl, resp);
  } catch (_) {}
}

async function verifyRecordPin(familyId, record, candidatePin) {
  const cleanPin = String(candidatePin || '').trim();
  if (!cleanPin) return null;

  const candidateHash = await hashPin(familyId, cleanPin);

  if (record.parentPinHash && candidateHash === record.parentPinHash) {
    return 'parent';
  }
  if (record.childPinHash && candidateHash === record.childPinHash) {
    return 'child';
  }

  // Legacy fallback if record had unhashed pins
  if (record.parentPin && cleanPin === record.parentPin) {
    return 'parent';
  }
  if (record.childPin && cleanPin === record.childPin) {
    return 'child';
  }

  return null;
}

/* ==========================================================================
   ANTI-SSRF & BAKALÁŘI URL WHITELIST FOR CORS PROXY
   ========================================================================== */
function validateBakalariTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { valid: false, reason: 'Neplatný formát cílové URL adresy.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Povoleny jsou pouze protokoly HTTP/HTTPS.' };
  }

  const host = parsed.hostname.toLowerCase();

  // Block localhost, loopback, link-local, and private IP ranges (Anti-SSRF)
  const blockedHostPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^169\.254\./,
    /^0\./,
    /^\[::1\]$/,
    /\.internal$/i,
    /\.local$/i,
    /workers\.dev$/i
  ];

  if (blockedHostPatterns.some((re) => re.test(host))) {
    return { valid: false, reason: 'Cílová adresa není povolena (interní nebo zakázaný hostitel).' };
  }

  // Path must target Bakaláři API (/api/ or /bakaweb/)
  const pathLower = parsed.pathname.toLowerCase();
  const isBakalariPath =
    pathLower.includes('/api/') ||
    pathLower.endsWith('/api') ||
    pathLower.includes('/bakaweb/') ||
    pathLower.endsWith('/login');

  if (!isBakalariPath) {
    return {
      valid: false,
      reason: 'Proxy je uzamčena výhradně pro školní rozhraní Bakaláři API (/api/...).'
    };
  }

  return { valid: true, url: parsed.toString() };
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const clientIp = getClientIp(request);

    /* ======================================================================
       A) MULTI-TENANT RODINNÁ SYNCHRONIZACE (/family/setup, /family/connect, /family/sync)
       ====================================================================== */
    if (reqUrl.pathname.startsWith('/family/')) {
      if (!isOriginAllowed(request)) {
        return new Response(
          JSON.stringify({ error: 'Přístup z nepovolené domény (Origin lock).' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      // Check IP rate limit before processing any family endpoint
      const rateState = await getRateLimitState(clientIp);
      if (rateState.attempts >= MAX_PIN_ATTEMPTS && Date.now() < rateState.expiresAt) {
        const remainingMin = Math.max(1, Math.ceil((rateState.expiresAt - Date.now()) / 60000));
        return new Response(
          JSON.stringify({
            error: `Příliš mnoho neúspěšných pokusů o zadání PINu (${MAX_PIN_ATTEMPTS}×). Přístup z vaší IP adresy je dočasně zablokován na ${remainingMin} min.`
          }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      // 1. POST /family/setup - Založení nebo aktualizace rodinného profilu
      if (reqUrl.pathname === '/family/setup' && request.method === 'POST') {
        try {
          const body = await request.json();
          const familyId = normalizeFamilyId(body.familyId);
          if (!familyId) {
            return new Response(
              JSON.stringify({ error: 'Zadejte platný Kód rodiny (4 až 24 znaků: písmena, čísla nebo pomlčka).' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const parentPin = String(body.parentPin || '').trim();
          const childPin = String(body.childPin || '').trim();

          if (parentPin.length < MIN_PIN_LENGTH || childPin.length < MIN_PIN_LENGTH) {
            return new Response(
              JSON.stringify({ error: `Rodičovský i Dětský PIN musí mít alespoň ${MIN_PIN_LENGTH} znaků.` }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          if (parentPin === childPin) {
            return new Response(
              JSON.stringify({ error: 'Rodičovský PIN a Dětský PIN se musí lišit.' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const existing = await loadFamilyRecord(env, familyId);

          // If this familyId already exists, require currentParentPin to prevent hijacking
          if (existing && (existing.parentPinHash || existing.parentPin)) {
            const verifyCurrent = await verifyRecordPin(familyId, existing, body.currentParentPin || parentPin);
            if (verifyCurrent !== 'parent') {
              const updatedRate = {
                attempts: rateState.attempts + 1,
                expiresAt: Date.now() + LOCKOUT_MS
              };
              await saveRateLimitState(clientIp, updatedRate);
              await sleep(900);
              return new Response(
                JSON.stringify({
                  error: `Rodina s kódem „${familyId}“ již existuje a zadaný stávající Rodičovský PIN nesouhlasí. Pokud zakládáte novou rodinu, zvolte jiný Kód rodiny.`
                }),
                { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
              );
            }
          }

          await clearRateLimitState(clientIp);

          const parentPinHash = await hashPin(familyId, parentPin);
          const childPinHash = await hashPin(familyId, childPin);

          const updatedRecord = {
            familyId,
            parentPinHash,
            childPinHash,
            shareBakalariAuth: Boolean(body.shareBakalariAuth),
            encryptedBakalariAuth: body.encryptedBakalariAuth || null,
            bakalariAuth: body.shareBakalariAuth ? (body.bakalariAuth || null) : null,
            clubs: Array.isArray(body.clubs) ? body.clubs : (existing?.clubs || []),
            customHomeworks: Array.isArray(body.customHomeworks) ? body.customHomeworks : (existing?.customHomeworks || []),
            hwDoneMap: body.hwDoneMap || existing?.hwDoneMap || {},
            confirmations: body.confirmations || existing?.confirmations || {},
            settings: body.settings || existing?.settings || {},
            updatedAt: new Date().toISOString()
          };

          await saveFamilyRecord(env, familyId, updatedRecord);

          return new Response(
            JSON.stringify({
              ok: true,
              familyId,
              role: 'parent',
              message: 'Rodinný profil a 8místné PINy byly bezpečně uloženy.',
              state: {
                shareBakalariAuth: updatedRecord.shareBakalariAuth,
                encryptedBakalariAuth: updatedRecord.encryptedBakalariAuth,
                bakalariAuth: updatedRecord.bakalariAuth,
                clubs: updatedRecord.clubs,
                customHomeworks: updatedRecord.customHomeworks,
                hwDoneMap: updatedRecord.hwDoneMap,
                confirmations: updatedRecord.confirmations,
                settings: updatedRecord.settings,
                updatedAt: updatedRecord.updatedAt
              }
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ error: 'Chyba při ukládání rodinného profilu: ' + err.message }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }
      }

      // 2. POST /family/connect - Připojení telefonu pomocí Kódu rodiny + 8místného PINu
      if (reqUrl.pathname === '/family/connect' && request.method === 'POST') {
        try {
          const { familyId: rawFamilyId, pin } = await request.json();
          const familyId = normalizeFamilyId(rawFamilyId);
          const cleanPin = String(pin || '').trim();

          if (!familyId) {
            return new Response(
              JSON.stringify({ error: 'Zadejte platný Kód rodiny (4–24 znaků).' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          if (cleanPin.length < MIN_PIN_LENGTH) {
            return new Response(
              JSON.stringify({ error: `PIN musí obsahovat alespoň ${MIN_PIN_LENGTH} znaků.` }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const record = await loadFamilyRecord(env, familyId);
          if (!record) {
            const updatedRate = {
              attempts: rateState.attempts + 1,
              expiresAt: Date.now() + LOCKOUT_MS
            };
            await saveRateLimitState(clientIp, updatedRate);
            await sleep(900);
            const left = Math.max(0, MAX_PIN_ATTEMPTS - updatedRate.attempts);
            return new Response(
              JSON.stringify({
                error: `Rodina s kódem „${familyId}“ nebyla nalezena nebo je PIN nesprávný (zbývá pokusů: ${left}).`
              }),
              { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const role = await verifyRecordPin(familyId, record, cleanPin);
          if (!role) {
            const updatedRate = {
              attempts: rateState.attempts + 1,
              expiresAt: Date.now() + LOCKOUT_MS
            };
            await saveRateLimitState(clientIp, updatedRate);
            await sleep(900);
            const left = Math.max(0, MAX_PIN_ATTEMPTS - updatedRate.attempts);
            return new Response(
              JSON.stringify({
                error:
                  left > 0
                    ? `Neplatný PIN pro rodinu „${familyId}“. Zbývající počet pokusů: ${left}.`
                    : `Neplatný PIN. Přístup je nyní na 15 minut zablokován.`
              }),
              { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          await clearRateLimitState(clientIp);

          return new Response(
            JSON.stringify({
              ok: true,
              familyId,
              role,
              state: {
                shareBakalariAuth: Boolean(record.shareBakalariAuth),
                encryptedBakalariAuth: record.encryptedBakalariAuth || null,
                bakalariAuth: record.shareBakalariAuth ? (record.bakalariAuth || null) : null,
                clubs: record.clubs || [],
                customHomeworks: record.customHomeworks || [],
                hwDoneMap: record.hwDoneMap || {},
                confirmations: record.confirmations || {},
                settings: record.settings || {},
                updatedAt: record.updatedAt
              }
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ error: 'Chyba ověření PINu: ' + err.message }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }
      }

      // 3. POST /family/sync - Synchronizace stavu v rámci rodiny
      if (reqUrl.pathname === '/family/sync' && request.method === 'POST') {
        try {
          const body = await request.json();
          const familyId = normalizeFamilyId(body.familyId);
          const cleanPin = String(body.pin || '').trim();

          if (!familyId || cleanPin.length < MIN_PIN_LENGTH) {
            return new Response(
              JSON.stringify({ error: 'Chybí platný Kód rodiny nebo 8místný PIN pro synchronizaci.' }),
              { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const record = await loadFamilyRecord(env, familyId);
          if (!record) {
            return new Response(
              JSON.stringify({ error: `Rodinný profil „${familyId}“ nebyl nalezen.` }),
              { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const role = await verifyRecordPin(familyId, record, cleanPin);
          if (!role) {
            const updatedRate = {
              attempts: rateState.attempts + 1,
              expiresAt: Date.now() + LOCKOUT_MS
            };
            await saveRateLimitState(clientIp, updatedRate);
            await sleep(900);
            return new Response(
              JSON.stringify({ error: 'Neplatný PIN pro synchronizaci.' }),
              { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }

          const isParent = role === 'parent';
          const isChild = role === 'child';

          if (isParent) {
            if (Array.isArray(body.clubs)) record.clubs = body.clubs;
            if (Array.isArray(body.customHomeworks)) record.customHomeworks = body.customHomeworks;
            if (body.settings) record.settings = { ...record.settings, ...body.settings };
            if (typeof body.shareBakalariAuth === 'boolean') {
              record.shareBakalariAuth = body.shareBakalariAuth;
              if (!body.shareBakalariAuth) {
                record.bakalariAuth = null;
                record.encryptedBakalariAuth = null;
              }
            }
            if (record.shareBakalariAuth) {
              if (body.encryptedBakalariAuth !== undefined) {
                record.encryptedBakalariAuth = body.encryptedBakalariAuth;
              }
              if (body.bakalariAuth !== undefined) {
                record.bakalariAuth = body.bakalariAuth;
              }
            }
          }

          if (body.hwDoneMap) {
            record.hwDoneMap = { ...(record.hwDoneMap || {}), ...body.hwDoneMap };
          }
          if (body.confirmations) {
            record.confirmations = { ...(record.confirmations || {}), ...body.confirmations };
          }
          if (isChild && Array.isArray(body.customHomeworks)) {
            record.customHomeworks = body.customHomeworks;
          }

          record.updatedAt = new Date().toISOString();
          await saveFamilyRecord(env, familyId, record);

          return new Response(
            JSON.stringify({
              ok: true,
              familyId,
              role,
              state: {
                shareBakalariAuth: Boolean(record.shareBakalariAuth),
                encryptedBakalariAuth: record.encryptedBakalariAuth || null,
                bakalariAuth: record.shareBakalariAuth ? (record.bakalariAuth || null) : null,
                clubs: record.clubs || [],
                customHomeworks: record.customHomeworks || [],
                hwDoneMap: record.hwDoneMap || {},
                confirmations: record.confirmations || {},
                settings: record.settings || {},
                updatedAt: record.updatedAt
              }
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ error: 'Chyba synchronizace: ' + err.message }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }
      }
    }

    /* ======================================================================
       B) UZAMČENÁ CORS PROXY PRO BAKALÁŘI API (?url=https://...)
       ====================================================================== */
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '1.2.0-multi-tenant-secured',
          service: 'Školní parťák – Multi-tenant Rodinný Cloud & Bakaláři API Proxy'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 1. Verify Origin lock
    if (!isOriginAllowed(request)) {
      return new Response(
        JSON.stringify({ error: 'CORS Proxy je uzamčena pouze pro aplikaci Školní parťák (Origin lock).' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 2. Verify allowed HTTP methods
    if (!['GET', 'POST', 'PUT'].includes(request.method)) {
      return new Response(
        JSON.stringify({ error: 'Nepovolená HTTP metoda.' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 3. Validate target URL (Bakaláři API path whitelist & Anti-SSRF)
    const validation = validateBakalariTargetUrl(targetUrl);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({ error: validation.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    const forwardHeaders = new Headers();
    const contentType = request.headers.get('Content-Type');
    const authorization = request.headers.get('Authorization');
    const accept = request.headers.get('Accept');

    if (contentType) forwardHeaders.set('Content-Type', contentType);
    if (authorization) forwardHeaders.set('Authorization', authorization);
    if (accept) forwardHeaders.set('Accept', accept);
    forwardHeaders.set('User-Agent', 'BakalariPWA/1.2 (Android)');

    try {
      const response = await fetch(validation.url, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : undefined
      });

      const responseBody = await response.text();
      return new Response(responseBody, {
        status: response.status,
        headers: {
          ...corsHeaders,
          'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8'
        }
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Nelze se spojit se serverem Bakaláři', detail: err.message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
  }
};
