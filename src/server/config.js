const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];
const DEFAULT_PREFERENCES = {
  post_body_parameter_overrides: {}
};

export function createRuntimeConfig() {
  return {
    configured: false,
    requireApiKey: false,
    apiKeys: new Set(),
    apiKeyProfiles: new Map(),
    vertex: null
  };
}

export function resetRuntimeConfig(config) {
  config.configured = false;
  config.requireApiKey = false;
  config.apiKeys = new Set();
  config.apiKeyProfiles = new Map();
  config.vertex = null;
  return config;
}

export function applyRuntimeConfig(config, input) {
  const vertex = normalizeVertexConfig(input?.vertex || input || {});
  const apiKeys = Array.isArray(input?.apiKeys) ? input.apiKeys : splitLines(input?.apiKeys);

  config.configured = true;
  config.requireApiKey = Boolean(input?.requireApiKey);
  config.apiKeys = new Set(apiKeys.map((key) => tokenValue(key)).filter(Boolean));
  config.apiKeyProfiles = new Map(
    apiKeys
      .map((key) => [tokenValue(key), typeof key === 'object' ? key.profileId || '' : ''])
      .filter(([value]) => value)
  );
  config.vertex = vertex;

  return config;
}

export function publicConfig(config) {
  return {
    configured: config.configured,
    requireApiKey: config.requireApiKey,
    apiKeyCount: config.apiKeys.size,
    vertex: config.vertex
      ? {
          projectId: config.vertex.projectId,
          clientEmail: config.vertex.clientEmail,
          privateKeySet: Boolean(config.vertex.privateKey),
          location: config.vertex.location,
          models: config.vertex.models,
          preferences: config.vertex.preferences
        }
      : null
  };
}

export function assertConfigured(config) {
  if (!config.configured || !config.vertex) {
    const error = new Error('Vertex AI is not configured. Open the web UI and save your Vertex settings first.');
    error.status = 409;
    throw error;
  }
}

export function assertApiKey(config, authorization) {
  if (!config.requireApiKey) {
    return;
  }

  if (config.apiKeys.size === 0) {
    return;
  }

  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token || !config.apiKeys.has(token)) {
    const error = new Error('Invalid API key');
    error.status = 401;
    throw error;
  }

  return config.apiKeyProfiles.get(token) || null;
}

function normalizeVertexConfig(input) {
  const projectId = String(input.projectId || input.project_id || '').trim();
  const clientEmail = String(input.clientEmail || input.client_email || '').trim();
  const privateKey = normalizePrivateKey(input.privateKey || input.private_key || '');
  const location = String(input.location || process.env.VERTEX_LOCATION || 'global').trim() || 'global';
  const models = normalizeModels(input.models || input.model);
  const preferences = defaultPreferences();

  if (!projectId || !clientEmail || !privateKey) {
    const error = new Error('Project ID, client email, and private key are required.');
    error.status = 400;
    throw error;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
    location,
    models,
    preferences
  };
}

function normalizePrivateKey(value) {
  let key = value;

  if (key && typeof key === 'object') {
    key = key.privateKey || key.private_key || '';
  }

  key = String(key || '').trim();

  if (key.startsWith('{') || key.startsWith('"')) {
    try {
      const parsed = JSON.parse(key);
      key = typeof parsed === 'object' && parsed
        ? parsed.privateKey || parsed.private_key || ''
        : parsed;
    } catch {
      // Keep the original value and continue with best-effort PEM cleanup.
    }
  }

  key = String(key || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }

  key = key
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  return normalizePemLineBreaks(key);
}

function normalizePemLineBreaks(key) {
  const match = key.match(/^(-----BEGIN [^-]+-----)\s*([A-Za-z0-9+/=\s]+?)\s*(-----END [^-]+-----)$/s);
  if (!match) return key;

  const [, header, body, footer] = match;
  const compactBody = body.replace(/\s+/g, '');
  const wrappedBody = compactBody.match(/.{1,64}/g)?.join('\n') || compactBody;
  return `${header}\n${wrappedBody}\n${footer}`;
}

function normalizeModels(value) {
  const models = Array.isArray(value) ? value : splitLines(value);
  const cleaned = models.map((model) => String(model).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : DEFAULT_MODELS;
}

function defaultPreferences() {
  return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenValue(key) {
  return String(typeof key === 'object' ? key.value || '' : key || '').trim();
}
