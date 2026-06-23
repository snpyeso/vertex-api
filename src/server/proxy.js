import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

let currentProxyUrl = '';
let manualProxyOverride = '';
let lastRefreshAt = 0;

const COMMON_LOCAL_PROXIES = [
  'http://127.0.0.1:7897',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080',
  'http://127.0.0.1:8080'
];

export function configureProxy(proxyOverride) {
  if (proxyOverride !== undefined) {
    manualProxyOverride = normalizeProxyUrl(proxyOverride);
  }

  const proxyUrl = resolveConfiguredProxy() || normalizeProxyUrl(readWindowsProxy());
  applyProxy(proxyUrl);
  lastRefreshAt = 0;
  return currentProxyUrl;
}

export async function refreshProxyIfNeeded(options = {}) {
  const refreshMs = timeoutMs('VERTEX_PROXY_REFRESH_MS', 10000);
  if (!options.force && Date.now() - lastRefreshAt < refreshMs) {
    return currentProxyUrl;
  }

  lastRefreshAt = Date.now();
  const proxyUrl = await detectProxyUrl();
  applyProxy(proxyUrl);
  return currentProxyUrl;
}

export async function refreshProxyNow() {
  return refreshProxyIfNeeded({ force: true });
}

export function getCurrentProxyUrl() {
  return currentProxyUrl;
}

async function detectProxyUrl() {
  const configuredProxy = resolveConfiguredProxy();
  if (configuredProxy) return configuredProxy;

  const windowsProxy = normalizeProxyUrl(readWindowsProxy());
  if (windowsProxy) return windowsProxy;

  for (const proxy of COMMON_LOCAL_PROXIES) {
    if (await canConnect(proxy)) return proxy;
  }

  return '';
}

function resolveConfiguredProxy() {
  return normalizeProxyUrl(
    manualProxyOverride ||
      process.env.VERTEX_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.http_proxy
  );
}

function applyProxy(proxyUrl) {
  if (proxyUrl === currentProxyUrl) return;

  const dispatcherOptions = {
    bodyTimeout: timeoutMs('VERTEX_BODY_TIMEOUT_MS', 0),
    headersTimeout: timeoutMs('VERTEX_HEADERS_TIMEOUT_MS', 0)
  };

  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, ...dispatcherOptions }));
  } else {
    setGlobalDispatcher(new Agent(dispatcherOptions));
  }

  currentProxyUrl = proxyUrl;
  console.log(proxyUrl ? `Using proxy ${proxyUrl}` : 'Using direct Vertex connection');
}

function normalizeProxyUrl(proxy) {
  if (!proxy) return '';
  const trimmed = proxy.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function canConnect(proxyUrl) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(proxyUrl);
    } catch {
      resolve(false);
      return;
    }

    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 80),
      timeout: timeoutMs('VERTEX_PROXY_PROBE_TIMEOUT_MS', 300)
    });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function readWindowsProxy() {
  if (process.platform !== 'win32') return '';

  try {
    const enabledOutput = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyEnable'
    ], { encoding: 'utf8' });

    if (!/\s0x1\s*$/im.test(enabledOutput)) {
      return '';
    }

    const serverOutput = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer'
    ], { encoding: 'utf8' });
    const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    return parseWindowsProxyServer(match?.[1] || '');
  } catch {
    return '';
  }
}

function parseWindowsProxyServer(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const entries = trimmed.split(';').map((item) => item.trim()).filter(Boolean);
  const protocolEntry = entries.find((item) => /^https?=/i.test(item));
  if (protocolEntry) {
    return protocolEntry.split('=').slice(1).join('=');
  }

  return entries[0] || trimmed;
}
