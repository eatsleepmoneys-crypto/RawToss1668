/**
 * Cloudflare Pages Function — API Proxy
 * Browser → /api/* (same-origin, no preflight) → Cloudflare Function → Railway backend
 *
 * Key: strip Origin/Referer so Railway sees a server-to-server request (no CORS/WAF block)
 */

const BACKEND = 'https://rawtoss1668-production.up.railway.app';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = BACKEND + url.pathname + url.search;
  const method = request.method.toUpperCase();

  // Build forward headers — strip browser/CF headers that trigger Railway WAF
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'origin' ||         // ← ลบออก: ให้ Railway เห็นเป็น server request
      lower === 'referer' ||
      lower === 'sec-fetch-site' ||
      lower === 'sec-fetch-mode' ||
      lower === 'sec-fetch-dest' ||
      lower === 'sec-ch-ua' ||
      lower === 'sec-ch-ua-mobile' ||
      lower === 'sec-ch-ua-platform' ||
      lower.startsWith('cf-') ||
      lower.startsWith('x-forwarded')
    ) continue;
    forwardHeaders.set(key, value);
  }

  // Read body for POST/PUT/PATCH
  let body = undefined;
  if (!['GET', 'HEAD'].includes(method)) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) body = buf;
  }

  try {
    const backendResponse = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
    });

    // Forward response — strip Railway CORS headers (not needed: browser calls same-origin)
    const resHeaders = new Headers();
    for (const [key, value] of backendResponse.headers.entries()) {
      if (key.toLowerCase().startsWith('access-control-')) continue;
      resHeaders.set(key, value);
    }

    return new Response(backendResponse.body, {
      status: backendResponse.status,
      statusText: backendResponse.statusText,
      headers: resHeaders,
    });
  } catch (err) {
    return Response.json(
      { success: false, message: 'Proxy error: ' + err.message },
      { status: 502 }
    );
  }
}
