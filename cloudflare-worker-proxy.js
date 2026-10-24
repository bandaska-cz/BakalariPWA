/* ==========================================================================
   CLOUDFLARE WORKER - BEZPLATNÁ HTTPS CORS PROXY PRO BAKALÁŘI API v3
   Ideální při provozu aplikace na GitHub Pages + v mobilu kdekoli mimo domov.
   
   Jak nasadit (zdarma za 2 minuty):
   1. Přihlaste se na https://dash.cloudflare.com -> Workers & Pages -> Create Worker
   2. Vložte tento kód a klikněte na "Deploy".
   3. Získáte HTTPS adresu (např. https://bakalari-proxy.vase-jmeno.workers.dev).
   4. Tuto adresu zadejte v aplikaci v záložce "⚙️ Bakaláři & Časy" do pole CORS Proxy URL.
   ========================================================================== */

export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept'
    };

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: 'Chybí parametr ?url=https://...' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 2. Forward request to the school's Bakaláři server
    const forwardHeaders = new Headers();
    const contentType = request.headers.get('Content-Type');
    const authorization = request.headers.get('Authorization');
    const accept = request.headers.get('Accept');

    if (contentType) forwardHeaders.set('Content-Type', contentType);
    if (authorization) forwardHeaders.set('Authorization', authorization);
    if (accept) forwardHeaders.set('Accept', accept);
    forwardHeaders.set('User-Agent', 'BakalariPWA/1.0 (Android)');

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

