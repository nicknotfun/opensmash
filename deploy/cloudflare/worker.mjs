/** Public Cloudflare entrypoint for the Cloud Run website. */
function origin(value, name) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return parsed;
}

function configuration(env) {
  const site = origin(env.SITE_ORIGIN, 'SITE_ORIGIN');
  const upstream = origin(env.CLOUD_RUN_ORIGIN, 'CLOUD_RUN_ORIGIN');
  if (!/^[a-z0-9][a-z0-9.-]*\.run\.app$/.test(upstream.hostname) ||
      site.origin === upstream.origin) {
    throw new Error('CLOUD_RUN_ORIGIN must be a distinct Cloud Run origin');
  }
  return { site, upstream };
}

function failure(status, message) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
    },
  });
}

export async function proxyRequest(request, env, fetchOrigin = fetch) {
  let config;
  try {
    config = configuration(env);
  } catch {
    return failure(503, 'The website origin is not configured.');
  }
  const incoming = new URL(request.url);
  if (incoming.protocol === 'http:' && incoming.host === config.site.host) {
    incoming.protocol = 'https:';
    return new Response(null, {
      status: 308,
      headers: { Location: incoming.href, 'Cache-Control': 'no-store' },
    });
  }
  if (incoming.origin !== config.site.origin) {
    return failure(421, 'This hostname is not configured for the website.');
  }

  // Assign the path separately: a path beginning with // must never choose a host.
  const target = new URL(config.upstream);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.delete('Forwarded');
  headers.set('X-Forwarded-Host', config.site.host);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Forwarded-Port', '443');
  headers.delete('X-Forwarded-For');
  const clientAddress = request.headers.get('CF-Connecting-IP');
  if (clientAddress) headers.set('X-Forwarded-For', clientAddress);

  const upstreamRequest = new Request(new Request(target, request), {
    headers,
    redirect: 'manual', // Never forward cookies or Authorization across a redirect.
    cache: 'no-store',
  });
  let response;
  try {
    response = await fetchOrigin(upstreamRequest);
  } catch {
    return failure(502, 'The website origin is temporarily unavailable.');
  }

  const responseHeaders = new Headers(response.headers);
  // Preserve browser caching of public engine assets, but share no origin response
  // in a CDN cache. Public character bundles have their own asset hostname.
  responseHeaders.set('Cloudflare-CDN-Cache-Control', 'no-store');
  responseHeaders.set('CDN-Cache-Control', 'no-store');
  if (incoming.pathname === '/api' || incoming.pathname.startsWith('/api/') ||
      request.headers.has('Cookie') || request.headers.has('Authorization') ||
      response.headers.has('Set-Cookie')) {
    responseHeaders.set('Cache-Control', 'private, no-store');
  }
  const location = responseHeaders.get('Location');
  if (location) {
    try {
      const destination = new URL(location, target);
      if (destination.origin === config.upstream.origin) {
        destination.protocol = config.site.protocol;
        destination.host = config.site.host;
        responseHeaders.set('Location', destination.href);
      }
    } catch { /* Keep an unusual origin Location unchanged. */ }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export default {
  fetch(request, env) {
    return proxyRequest(request, env);
  },
};
