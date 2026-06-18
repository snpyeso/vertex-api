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
  return String(value).trim().replaceAll('\\n', '\n');
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
