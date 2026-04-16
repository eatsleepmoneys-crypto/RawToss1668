/**
 * Cloudflare Pages Function — API Proxy
 * /api/* → https://rawtoss1668-production.up.railway.app/api/*
 */

const BACKEND = 'https://rawtoss1668-production.up.railway.app';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = BACKEND + url.pathname + url.search;

  // Build forward headers (strip hop-by-hop Cloudflare headers)
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower.startsWith('cf-') ||
      lower === 'x-forwarded-for' ||
      lower === 'x-forwarded-proto' ||
      lower === 'x-real-ip'
    ) {
      continue;
    }
    forwardHeaders.set(key, value);
  }

  // Read body as ArrayBuffer to avoid streaming issues in Cloudflare Workers
  const method = request.method.toUpperCase();
  let body = undefined;
  if (!['GET', 'HEAD'].includes(method)) {
    try {
      const buf = await request.arrayBuffer();
      body = buf.byteLength > 0 ? buf : undefined;
    } catch (_) {
      // no body
    }
  }

  try {
    const backendResponse = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
    });

    // Forward response headers, strip CORS (no longer needed — same origin)
    const responseHeaders = new Headers();
    for (const [key, value] of backendResponse.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('access-control-')) continue;
      responseHeaders.set(key, value);
    }

    return new Response(backendResponse.body, {
      status: backendResponse.status,
      statusText: backendResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, message: 'Proxy error: ' + err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
