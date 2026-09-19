import { createServer } from 'node:http';
import { parseFingerprintKey, WrappingKeyStore } from '@platform-hub/credential-custody';
import { createCustodyVaultFromEnv } from './vault.ts';
import {
  handleCredentials,
  handleHealth,
  handleWrappingKey,
  type CustodyRouteDeps,
} from './routes.ts';

const wrappingKeys = new WrappingKeyStore(120);

function loadDeps(): CustodyRouteDeps {
  return {
    wrappingKeys,
    vault: createCustodyVaultFromEnv(),
    fingerprintKey: parseFingerprintKey(process.env.CUSTODY_FINGERPRINT_KEY),
  };
}

async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && (path === '/health' || path === '/')) {
    return handleHealth();
  }

  // Vault is required only for credential paths so /health stays probeable.
  let deps: CustodyRouteDeps;
  try {
    deps = loadDeps();
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Custody vault not configured.',
        reasonKey: 'CUSTODY_VAULT_REQUIRED',
      }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  if (request.method === 'GET' && path === '/api/custody/wrapping-key') {
    return handleWrappingKey(request, deps);
  }
  if (request.method === 'POST' && path === '/api/custody/credentials') {
    return handleCredentials(request, deps);
  }

  return new Response(JSON.stringify({ error: 'Not found.' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

const bind = process.env.CUSTODY_BIND?.trim() || '127.0.0.1:8787';
const [host, portText] = bind.includes(':') ? bind.split(':') : ['127.0.0.1', bind];
const port = Number(portText) || 8787;

const server = createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host ?? `${host}:${port}`;
    const url = `http://${hostHeader}${req.url ?? '/'}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });
    const response = await dispatch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    res.end(responseBody);
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal custody error.' }));
  }
});

server.listen(port, host, () => {
  // Intentionally no request bodies in logs — bind only.
  console.info(JSON.stringify({ msg: 'custody-service listening', host, port }));
});
