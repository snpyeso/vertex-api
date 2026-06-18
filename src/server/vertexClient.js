import crypto from 'node:crypto';

const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];
const DEFAULT_MIN_INTERVAL_MS = 60000;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
let vertexRequestQueue = Promise.resolve();
let lastVertexRequestAt = 0;

export class VertexClient {
  constructor(vertexConfig) {
    this.vertexConfig = vertexConfig;
    this.token = null;
  }

  async generateContent(model, body) {
    const endpoint = this.buildEndpoint(model, 'generateContent');
    const response = await this.fetchVertex(endpoint, body);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    return payload;
  }

  async *streamGenerateContent(model, body) {
    const endpoint = `${this.buildEndpoint(model, 'streamGenerateContent')}?alt=sse`;
    const response = await this.fetchVertex(endpoint, body);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI stream request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    yield* parseSseStream(response.body);
  }

  async fetchVertex(endpoint, body) {
    const maxRetries = retryAttempts();
    let lastResponse = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const token = await this.getAccessToken();
      await waitForVertexTurn();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!shouldRetry(response, attempt, maxRetries)) {
        return response;
      }

      lastResponse = response;
      await sleep(retryDelayMs(response, attempt));
    }

    return lastResponse;
  }

  buildEndpoint(model, method) {
    const { projectId, location } = this.vertexConfig;
    const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
    return `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}`;
  }

  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) {
      return this.token.accessToken;
    }

    const assertion = this.createJwtAssertion(now);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error_description || payload.error || response.statusText;
      const error = new Error(`Google OAuth token request failed: ${message}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    this.token = {
      accessToken: payload.access_token,
      expiresAt: now + Number(payload.expires_in || 3600)
    };
    return this.token.accessToken;
  }

  createJwtAssertion(now) {
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64Url(JSON.stringify({
      iss: this.vertexConfig.clientEmail,
      scope: VERTEX_SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now
    }));
    const unsigned = `${header}.${claim}`;
    let signature;
    try {
      signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.vertexConfig.privateKey);
    } catch (error) {
      const wrapped = new Error('Private key could not be parsed. Paste the service account private_key value or the full service account JSON, then save the profile again.');
      wrapped.status = 400;
      wrapped.details = { code: error.code, message: error.message };
      throw wrapped;
    }
    return `${unsigned}.${base64Url(signature)}`;
  }
}

function retryAttempts() {
  const value = Number(process.env.VERTEX_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function waitForVertexTurn() {
  const previous = vertexRequestQueue;
  let release;
  vertexRequestQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    const interval = minIntervalMs();
    const waitMs = Math.max(0, lastVertexRequestAt + interval - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastVertexRequestAt = Date.now();
  } finally {
    release();
  }
}

function minIntervalMs() {
  const value = Number(process.env.VERTEX_MIN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MIN_INTERVAL_MS;
}

function shouldRetry(response, attempt, maxRetries) {
  return attempt < maxRetries && RETRY_STATUS_CODES.has(response.status);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const customDelays = String(process.env.VERTEX_RETRY_DELAYS_MS || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const delays = customDelays.length > 0 ? customDelays : DEFAULT_RETRY_DELAYS_MS;
  return delays[Math.min(attempt, delays.length - 1)];
}

function friendlyVertexMessage(status, message) {
  if (status === 429) {
    return `${message} Retried automatically but Vertex AI quota/rate limit is still exhausted. Reduce request rate, switch model/location, or request a higher quota in Google Cloud.`;
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';

    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
