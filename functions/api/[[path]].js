/**
 * Cloudflare Pages Function — API Proxy
 * Browser → /api/* (same-origin, no CORS preflight) → CF Function → Railway backend
 *
 * Fix: wrap EVERYTHING in try/catch, use request.text() instead of arrayBuffer(),
 *      use new Response() instead of Response.json() for compatibility
 */

const BACKEND = 'https://rawtoss1668-production.up.railway.app';

const SKIP_HEADERS = new Set([
  'host', 'origin', 'referer',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
]);

export async function onRequest(context) {
  try {
    const { request } = context;
    const url = new URL(request.url);
    const targetUrl = BACKEND + url.pathname + url.search;
    const method = request.method.toUpperCase();

    // ─── Forward headers ───────────────────────────────────────────
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (SKIP_HEADERS.has(lower) || lower.startsWith('cf-') || lower.startsWith('x-forwarded')) {
        continue;
      }
      forwardHeaders.set(key, value);
    }

    // ─── Read body ─────────────────────────────────────────────────
    // Use text() instead of arrayBuffer() — more compatible with CF Workers
    let body = undefined;
    if (!['GET', 'HEAD'].includes(method)) {
      const text = await request.text();  // always works, even for JSON bodies
      if (text && text.length > 0) body = text;
    }

    // ─── Forward to Railway ────────────────────────────────────────
    const backendRes = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
    });

    // ─── Build response ─────────────────────────────────────────────
    const resHeaders = new Headers();
    for (const [key, value] of backendRes.headers.entries()) {
      // Strip CORS headers — browser sees same-origin request, doesn't need them
      if (key.toLowerCase().startsWith('access-control-')) continue;
      resHeaders.set(key, value);
    }

    const resBody = await backendRes.text();

    return new Response(resBody, {
      status: backendRes.status,
      statusText: backendRes.statusText,
      headers: resHeaders,
    });

  } catch (err) {
    // Use new Response() — Response.json() not available in all CF runtimes
    return new Response(
      JSON.stringify({ success: false, message: 'Proxy error: ' + err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
