import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FcmProvider } from './fcm.mjs';
import { createCompanionRelay } from './server.mjs';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.LOLICODE_COMPANION_PORT ?? 18789);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid companion port');

try {
  const relay = await createCompanionRelay({ host: process.env.LOLICODE_COMPANION_HOST ?? '127.0.0.1', port,
    stateDirectory: process.env.LOLICODE_COMPANION_STATE_DIRECTORY ?? resolve(packageDirectory, 'data'),
    allowInsecureLocal: process.env.LOLICODE_COMPANION_ALLOW_INSECURE_LOCAL === 'true',
    trustProxy: process.env.LOLICODE_COMPANION_TRUST_PROXY !== 'false',
    pushProvider: new FcmProvider({ serviceAccountPath: process.env.LOLICODE_COMPANION_FCM_SERVICE_ACCOUNT }) });
  console.info(JSON.stringify({ service: 'lolicode-companion-relay', state: 'listening',
    port: relay.address.port, pushConfigured: Boolean(process.env.LOLICODE_COMPANION_FCM_SERVICE_ACCOUNT) }));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await relay.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  console.error('Companion relay failed to start; check configuration and private state permissions.');
  process.exitCode = 1;
}
