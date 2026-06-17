import { execFileSync } from 'node:child_process';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

let currentProxyUrl = '';

export function configureProxy(proxyOverride) {
  const proxyUrl = normalizeProxyUrl(
    proxyOverride ||
      process.env.VERTEX_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.http_proxy ||
      readWindowsProxy()
  );

  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } else {
    setGlobalDispatcher(new Agent());
  }

  currentProxyUrl = proxyUrl;
  return proxyUrl;
}

export function getCurrentProxyUrl() {
  return currentProxyUrl;
}

function normalizeProxyUrl(proxy) {
  if (!proxy) return '';
  const trimmed = proxy.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
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
    return match?.[1]?.split(';')[0] || '';
  } catch {
    return '';
  }
}
