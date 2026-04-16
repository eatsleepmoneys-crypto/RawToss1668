/**
 * Cloudflare Pages Function — API Proxy
 * /api/* → https://rawtoss1668-production.up.railway.app/api/*
 *
 * เหตุผลที่ใช้ proxy:
 * - บราวเซอร์เรียก /api/... บน rawtoss1668.pages.dev (same-origin → ไม่มี CORS preflight)
 * - Cloudflare ส่งต่อ request ไป Railway แบบ server-to-server (ไม่ต้องส่ง Origin → ไม่มี CORS)
 */

const BACKEND = 'https://rawtoss1668-production.up.railway.app';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetUrl = BACKEND + url.pathname + url.search;

  // สร้าง headers ใหม่ — ลบ hop-by-hop headers ออก
  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-proto');

  const isBodyMethod = !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method.toUpperCase());

  try {
    const response = await fetch(targetUrl, {
      method: context.request.method,
      headers,
      body: isBodyMethod ? context.request.body : undefined,
    });

    // ส่งกลับ response ตรงๆ (ไม่ต้องเพิ่ม CORS headers เพราะ same-origin)
    const responseHeaders = new Headers(response.headers);
    // ลบ CORS headers จาก Railway ออก (ไม่จำเป็นเพราะ same-origin)
    responseHeaders.delete('access-control-allow-origin');
    responseHeaders.delete('access-control-allow-credentials');
    responseHeaders.delete('access-control-allow-methods');
    responseHeaders.delete('access-control-allow-headers');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: 'Proxy error: ' + err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
