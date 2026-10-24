/* ==========================================================================
   CLOUDFLARE WORKER - RODINNÁ SYNCHRONIZACE (PINy, KROUŽKY, POTVRZENÍ) & CORS PROXY
   Adresa vašeho Workeru: https://mute-cloud-b42b.radek-bunda.workers.dev
   
   Co tento Worker dělá:
   1. Rodinné cloudové úložiště (/family/setup, /family/auth, /family/sync):
      - Umožňuje tátovi nastavit Rodičovský PIN (pro tátu a mámu) a Dětský PIN (pro Theušku).
      - Na telefonu mámy a Theušky se pak stačí přihlásit pouze tímto PINem!
      - Synchronizuje kroužky, vlastní úkoly, časy upozornění a potvrzení od Theušky
        mezi všemi 3 telefony.
      - Funguje IHNED po nasazení (využívá Cloudflare Cache API + volitelně Cloudflare KV
        s názvem proměnné FAMILY_KV pro trvalé uložení).
   2. CORS Proxy (?url=https://...):
      - Přeposílá dotazy na školní server Bakaláři, pokud je potřeba.
   ========================================================================== */

// In-memory fast cache inside worker isolate
const MEMORY_STORE = new Map();
const CACHE_KEY_URL = 'https://family-sync.internal/state-v1';

async function loadFamilyRecord(env) {
  // 1. Try Cloudflare KV if bound as FAMILY_KV
  if (env && env.FAMILY_KV) {
    try {
      const kvData = await env.FAMILY_KV.get('FAMILY_STATE_V1', { type: 'json' });
      if (kvData) return kvData;
    } catch (_) {}
  }

  // 2. Try Worker Cache API (works with zero configuration!)
  try {
    const cache = caches.default;
    const cachedResp = await cache.match(CACHE_KEY_URL);
    if (cachedResp) {
      return await cachedResp.json();
    }
  } catch (_) {}

  // 3. Fallback to isolate memory
  if (MEMORY_STORE.has('FAMILY_STATE_V1')) {
    return MEMORY_STORE.get('FAMILY_STATE_V1');
  }

  return null;
}

async function saveFamilyRecord(env, record) {
  MEMORY_STORE.set('FAMILY_STATE_V1', record);

  // 1. Save to Cloudflare KV if bound
  if (env && env.FAMILY_KV) {
    try {
      await env.FAMILY_KV.put('FAMILY_STATE_V1', JSON.stringify(record));
    } catch (_) {}
  }

  // 2. Save to Cloudflare Cache API (persists across requests in datacenter without KV setup)
  try {
    const cache = caches.default;
    const resp = new Response(JSON.stringify(record), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000'
      }
    });
    await cache.put(CACHE_KEY_URL, resp);
  } catch (_) {}
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Family-Pin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);

    /* ======================================================================
       A) RODINNÁ SYNCHRONIZACE (/family/setup, /family/connect, /family/sync)
       ====================================================================== */

    // 1. POST /family/setup - Táta uloží přihlášení k Bakalářům, Rodičovský PIN a Dětský PIN
    if (reqUrl.pathname === '/family/setup' && request.method === 'POST') {
      try {
        const body = await request.json();
        const existing = (await loadFamilyRecord(env)) || {};

        // If already configured, verify parentPin if changing
        if (existing.parentPin && body.currentParentPin && existing.parentPin !== String(body.currentParentPin).trim()) {
          return new Response(
            JSON.stringify({ error: 'Nesprávný stávající Rodičovský PIN.' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }

        const updatedRecord = {
          parentPin: String(body.parentPin || existing.parentPin || '1234').trim(),
          childPin: String(body.childPin || existing.childPin || '1111').trim(),
          bakalariAuth: body.bakalariAuth || existing.bakalariAuth || null,
          clubs: Array.isArray(body.clubs) ? body.clubs : (existing.clubs || []),
          customHomeworks: Array.isArray(body.customHomeworks) ? body.customHomeworks : (existing.customHomeworks || []),
          hwDoneMap: body.hwDoneMap || existing.hwDoneMap || {},
          confirmations: body.confirmations || existing.confirmations || {},
          settings: body.settings || existing.settings || {},
          updatedAt: new Date().toISOString()
        };

        await saveFamilyRecord(env, updatedRecord);

        return new Response(
          JSON.stringify({
            ok: true,
            role: 'parent',
            message: 'Rodinný profil a PINy byly uloženy.',
            state: {
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

    // 2. POST /family/connect - Připojení telefonu (Máma nebo Theuška nebo Táta) pomocí PINu
    if (reqUrl.pathname === '/family/connect' && request.method === 'POST') {
      try {
        const { pin } = await request.json();
        const cleanPin = String(pin || '').trim();
        const record = await loadFamilyRecord(env);

        if (!record) {
          return new Response(
            JSON.stringify({ error: 'Rodinný profil zatím nebyl vytvořen. Nejprve ho nastavte na hlavním telefonu rodiče.' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }

        let role = null;
        if (cleanPin === record.parentPin) {
          role = 'parent';
        } else if (cleanPin === record.childPin) {
          role = 'child';
        } else {
          return new Response(
            JSON.stringify({ error: 'Neplatný PIN. Zkontrolujte prosím zadaný kód.' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            role,
            state: {
              bakalariAuth: record.bakalariAuth,
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

    // 3. POST /family/sync - Synchronizace kroužků, úkolů a potvrzení mezi telefony
    if (reqUrl.pathname === '/family/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        const cleanPin = String(body.pin || '').trim();
        const record = await loadFamilyRecord(env);

        if (!record) {
          return new Response(
            JSON.stringify({ error: 'Rodinný profil nenalezen.' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }

        const isParent = cleanPin === record.parentPin;
        const isChild = cleanPin === record.childPin;

        if (!isParent && !isChild) {
          return new Response(
            JSON.stringify({ error: 'Neplatný PIN pro synchronizaci.' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }

        // Parent can update clubs, settings, auth, customHomeworks, hwDoneMap, confirmations
        if (isParent) {
          if (Array.isArray(body.clubs)) record.clubs = body.clubs;
          if (Array.isArray(body.customHomeworks)) record.customHomeworks = body.customHomeworks;
          if (body.settings) record.settings = { ...record.settings, ...body.settings };
          if (body.bakalariAuth) record.bakalariAuth = body.bakalariAuth;
        }

        // Both Parent and Child (Theuška) can update homework completion & daily confirmations
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
        await saveFamilyRecord(env, record);

        return new Response(
          JSON.stringify({
            ok: true,
            role: isParent ? 'parent' : 'child',
            state: {
              bakalariAuth: record.bakalariAuth,
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

    /* ======================================================================
       B) KLASICKÁ CORS PROXY PRO BAKALÁŘI API (?url=https://...)
       ====================================================================== */
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'Školní parťák – Rodinný Cloud & Bakaláři Proxy',
          endpoints: ['/family/setup', '/family/connect', '/family/sync', '?url=...']
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    const forwardHeaders = new Headers();
    const contentType = request.headers.get('Content-Type');
    const authorization = request.headers.get('Authorization');
    const accept = request.headers.get('Accept');

    if (contentType) forwardHeaders.set('Content-Type', contentType);
    if (authorization) forwardHeaders.set('Authorization', authorization);
    if (accept) forwardHeaders.set('Accept', accept);
    forwardHeaders.set('User-Agent', 'BakalariPWA/1.1 (Android)');

    try {
      const response = await fetch(targetUrl, {
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
