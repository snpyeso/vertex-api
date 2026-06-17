import crypto from 'node:crypto';

const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';

export class VertexClient {
  constructor(vertexConfig) {
    this.vertexConfig = vertexConfig;
    this.token = null;
  }

  async generateContent(model, body) {
    const endpoint = this.buildEndpoint(model, 'generateContent');
    const token = await this.getAccessToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI request failed: ${message}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    return payload;
  }

  async *streamGenerateContent(model, body) {
    const endpoint = `${this.buildEndpoint(model, 'streamGenerateContent')}?alt=sse`;
    const token = await this.getAccessToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI stream request failed: ${message}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    yield* parseSseStream(response.body);
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
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.vertexConfig.privateKey);
    return `${unsigned}.${base64Url(signature)}`;
  }
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
