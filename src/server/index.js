import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRuntimeConfig, assertApiKey, assertConfigured, createRuntimeConfig, publicConfig, resetRuntimeConfig } from './config.js';
import { createDatabase } from './db.js';
import { anthropicToGemini, geminiChunkParts as anthropicChunkParts, geminiToAnthropic } from './anthropicGeminiMapper.js';
import { geminiChunkParts as openAiChunkParts, openAiToGemini, geminiToOpenAi } from './openaiGeminiMapper.js';
import { VertexClient } from './vertexClient.js';
import { configureProxy, getCurrentProxyUrl } from './proxy.js';
import { rememberToolCallSignature } from './thoughtSignatures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const database = createDatabase(rootDir);
const config = createRuntimeConfig();
let proxyUrl = configureProxy();
let vertexClient = null;
const vertexClients = new Map();
const app = express();
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
loadActiveRuntimeConfig();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    provider: 'vertex',
    configured: config.configured,
    project_id: config.vertex?.projectId || null,
    location: config.vertex?.location || null,
    proxy: Boolean(getCurrentProxyUrl()),
    require_api_key: config.requireApiKey,
    models: config.vertex?.models || []
  });
});

app.post('/auth/login', (req, res, next) => {
  try {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    if (!database.verifyPassword(username, password)) {
      return res.status(401).json({ error: { message: 'Invalid username or password' } });
    }

    const session = database.createSession(username);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true, user: { username } });
  } catch (error) {
    next(error);
  }
});

app.get('/auth/session', (req, res) => {
  const session = database.getSession(readSessionCookie(req));
  res.json({ authenticated: Boolean(session), user: session ? { username: session.username } : null });
});

app.post('/auth/logout', (req, res) => {
  const token = readSessionCookie(req);
  if (token) database.deleteSession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/auth/password', requireUiAuth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 6) {
    return res.status(400).json({ error: { message: 'New password must be at least 6 characters' } });
  }
  if (!database.verifyPassword(req.user.username, currentPassword)) {
    return res.status(401).json({ error: { message: 'Current password is incorrect' } });
  }
  database.changePassword(req.user.username, newPassword);
  clearSessionCookie(res);
  res.json({ ok: true, relogin: true });
});

app.get('/app/state', requireUiAuth, (_req, res) => {
  res.json(database.getState());
});

app.post('/app/profiles', requireUiAuth, (req, res) => {
  const profile = database.saveProfile(req.body);
  res.json({ profile, state: database.getState() });
});

app.put('/app/profiles/:id', requireUiAuth, (req, res) => {
  const profile = database.saveProfile({ ...req.body, id: req.params.id });
  if (database.getSetting('active_profile_id') === profile.id) loadActiveRuntimeConfig();
  res.json({ profile, state: database.getState() });
});

app.delete('/app/profiles/:id', requireUiAuth, (req, res) => {
  database.deleteProfile(req.params.id);
  loadActiveRuntimeConfig();
  res.json({ ok: true, state: database.getState() });
});

app.post('/app/active-profile', requireUiAuth, (req, res, next) => {
  try {
    database.setActiveProfile(req.body.id);
    loadActiveRuntimeConfig();
    res.json({ ok: true, config: publicConfig(config), state: database.getState() });
  } catch (error) {
    next(error);
  }
});

app.put('/app/tokens', requireUiAuth, (req, res) => {
  database.replaceTokens(req.body.tokens || []);
  loadActiveRuntimeConfig();
  res.json({ ok: true, config: publicConfig(config), state: database.getState() });
});

app.get('/app/vertex-logs', requireUiAuth, (_req, res) => {
  res.json({ logs: database.listVertexLogs() });
});

app.get('/app/vertex-logs/:id', requireUiAuth, (req, res) => {
  const log = database.getVertexLog(req.params.id);
  if (!log) return res.status(404).json({ error: { message: 'Log not found' } });
  res.json({ log });
});

app.get('/config', requireUiAuth, (_req, res) => {
  res.json(publicConfig(config));
});

app.post('/config', requireUiAuth, (req, res, next) => {
  try {
    applyRuntimeConfig(config, req.body);
    proxyUrl = configureProxy(req.body.proxyUrl);
    vertexClient = new VertexClient(config.vertex);
    res.json({
      ok: true,
      proxy: Boolean(proxyUrl),
      config: publicConfig(config)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/v1/models', (req, res, next) => {
  try {
    const context = getRequestContext(req, req.headers.authorization);
    res.json({
      object: 'list',
      data: context.vertex.models.map((model) => ({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'vertex'
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/chat/completions', async (req, res, next) => {
  const abortController = requestAbortController(req, res);
  try {
    const context = getRequestContext(req, req.headers.authorization);

    const model = req.body.model || context.vertex.models[0];
    if (!context.vertex.models.includes(model)) {
      return res.status(400).json({
        error: {
          message: `Model '${model}' is not configured`,
          type: 'invalid_request_error'
        }
      });
    }

    const overrides = context.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
    const vertexBody = openAiToGemini(req.body, overrides);
    if (req.body.stream) {
      return streamOpenAiResponse(res, model, collectVertexStream(context.client.streamGenerateContent(model, vertexBody, { signal: abortController.signal }), {
        endpoint: 'streamGenerateContent',
        model,
        request: vertexBody,
        signal: abortController.signal
      }));
    }

    const vertexResponse = await callVertexWithLog(context.client, {
      endpoint: 'generateContent',
      model,
      request: vertexBody,
      signal: abortController.signal
    });
    res.json(geminiToOpenAi(vertexResponse, model));
  } catch (error) {
    next(error);
  }
});

app.post('/v1/messages', async (req, res, next) => {
  const abortController = requestAbortController(req, res);
  try {
    const context = getRequestContext(req, req.headers.authorization || req.headers['x-api-key']);

    const model = req.body.model || context.vertex.models[0];
    if (!context.vertex.models.includes(model)) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `Model '${model}' is not configured`
        }
      });
    }

    const overrides = context.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
    const vertexBody = anthropicToGemini(req.body, overrides);
    if (req.body.stream) {
      return streamAnthropicResponse(res, model, collectVertexStream(context.client.streamGenerateContent(model, vertexBody, { signal: abortController.signal }), {
        endpoint: 'streamGenerateContent',
        model,
        request: vertexBody,
        signal: abortController.signal
      }));
    }

    const vertexResponse = await callVertexWithLog(context.client, {
      endpoint: 'generateContent',
      model,
      request: vertexBody,
      signal: abortController.signal
    });
    res.json(geminiToAnthropic(vertexResponse, model));
  } catch (error) {
    next(error);
  }
});

async function callVertexWithLog(client, log) {
  const startedAt = Date.now();
  try {
    const response = await client.generateContent(log.model, log.request, { signal: log.signal });
    saveVertexLog({ ...log, status: 200, durationMs: Date.now() - startedAt, response });
    return response;
  } catch (error) {
    saveVertexLog({
      ...log,
      status: error.name === 'AbortError' ? 499 : error.status || 500,
      durationMs: Date.now() - startedAt,
      response: error.details || { message: error.message },
      errorMessage: error.message
    });
    throw error;
  }
}

async function* collectVertexStream(stream, log) {
  const startedAt = Date.now();
  const chunks = [];
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      yield chunk;
    }
    saveVertexLog({
      ...log,
      status: 200,
      durationMs: Date.now() - startedAt,
      response: { chunks }
    });
  } catch (error) {
    saveVertexLog({
      ...log,
      status: error.name === 'AbortError' ? 499 : error.status || 500,
      durationMs: Date.now() - startedAt,
      response: error.details || { message: error.message },
      errorMessage: error.message
    });
    throw error;
  }
}

function requestAbortController(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.on('aborted', abort);
  res.on('close', () => {
    if (!res.writableFinished) abort();
  });
  return controller;
}

function saveVertexLog(log) {
  try {
    database.addVertexLog(log);
  } catch (error) {
    console.error('Failed to save Vertex log:', error.message);
  }
}

async function streamOpenAiResponse(res, model, stream) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let finished = false;

  setSseHeaders(res);
  const heartbeat = startSseHeartbeat(res, 'openai');
  writeSseData(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  });
  sentRole = true;

  try {
    for await (const geminiChunk of stream) {
      if (res.destroyed || res.writableEnded) break;
      if (!sentRole) {
        if (!writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        })) break;
        sentRole = true;
      }

      const chunk = openAiChunkParts(geminiChunk);
      if (chunk.text) {
        if (!writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }]
        })) break;
      }

      for (const [index, call] of chunk.functionCalls.entries()) {
        const toolCallId = `call_${index}_${crypto.randomUUID().replaceAll('-', '')}`;
        rememberToolCallSignature(toolCallId, call.thoughtSignature);
        if (!writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: toolCallId,
                    type: 'function',
                    extra_content: call.thoughtSignature ? { google: { thought_signature: call.thoughtSignature } } : undefined,
                    thought_signature: call.thoughtSignature,
                    thoughtSignature: call.thoughtSignature,
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args || {}),
                      thought_signature: call.thoughtSignature,
                      thoughtSignature: call.thoughtSignature
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })) break;
      }

      if (chunk.finishReason) {
        if (!writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: chunk.functionCalls.length ? 'tool_calls' : chunk.finishReason }]
        })) break;
        finished = true;
      }
    }

    if (!finished && !res.destroyed && !res.writableEnded) {
      writeSseData(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSseData(res, { error: { message: error.message, type: 'api_error', details: error.details } });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function streamAnthropicResponse(res, model, stream) {
  const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let contentIndex = 0;
  let textBlockOpen = false;
  let stopReason = 'end_turn';

  setSseHeaders(res);
  const heartbeat = startSseHeartbeat(res, 'anthropic');
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  try {
    for await (const geminiChunk of stream) {
      if (res.destroyed || res.writableEnded) break;
      const chunk = anthropicChunkParts(geminiChunk);
      if (chunk.text) {
        if (!textBlockOpen) {
          if (!writeSseEvent(res, 'content_block_start', {
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'text', text: '' }
          })) break;
          textBlockOpen = true;
        }
        if (!writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'text_delta', text: chunk.text }
        })) break;
      }

      for (const call of chunk.functionCalls) {
        if (textBlockOpen) {
          if (!writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })) break;
          contentIndex += 1;
          textBlockOpen = false;
        }

        const toolUseId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`;
        rememberToolCallSignature(toolUseId, call.thoughtSignature);
        if (!writeSseEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: call.name,
            input: {},
            thought_signature: call.thoughtSignature,
            thoughtSignature: call.thoughtSignature
          }
        })) break;
        if (!writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args || {}) }
        })) break;
        if (!writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })) break;
        contentIndex += 1;
        stopReason = 'tool_use';
      }

      if (chunk.finishReason && stopReason !== 'tool_use') {
        stopReason = chunk.finishReason;
      }
    }

    if (textBlockOpen && !res.destroyed && !res.writableEnded) {
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex });
    }
    if (!res.destroyed && !res.writableEnded) {
      writeSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 }
      });
      writeSseEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
    }
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSseEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: error.message }
      });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function setSseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
}

function writeSseData(res, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function writeSseEvent(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  return writeSseData(res, data);
}

function startSseHeartbeat(res, format) {
  return setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      if (format === 'anthropic') {
        writeSseEvent(res, 'ping', { type: 'ping' });
      } else {
        res.write(': ping\n\n');
      }
    }
  }, 15000);
}

function loadActiveRuntimeConfig() {
  const activeProfile = database.getActiveProfile();
  if (!activeProfile || !isCompleteProfile(activeProfile)) {
    resetRuntimeConfig(config);
    vertexClient = null;
    return;
  }

  const tokens = database.listTokens();
  applyRuntimeConfig(config, {
    requireApiKey: tokens.length > 0,
    apiKeys: tokens.map((token) => ({ value: token.value, profileId: token.profileId })),
    vertex: profileToVertexInput(activeProfile)
  });
  vertexClient = getVertexClient(activeProfile);
}

function isCompleteProfile(profile) {
  return Boolean(
    String(profile?.projectId || '').trim() &&
      String(profile?.clientEmail || '').trim() &&
      String(profile?.privateKey || '').trim()
  );
}

function getRequestContext(_req, authorization) {
  assertConfigured(config);
  const profileId = assertApiKey(config, authorization);
  const profile = profileId ? database.getProfile(profileId) : database.getActiveProfile();
  if (!profile) {
    return { vertex: config.vertex, client: vertexClient };
  }

  return {
    vertex: profileToRuntimeVertex(profile),
    client: getVertexClient(profile)
  };
}

function getVertexClient(profile) {
  const cacheKey = profileCacheKey(profile);
  if (!vertexClients.has(cacheKey)) {
    vertexClients.set(cacheKey, new VertexClient(profileToRuntimeVertex(profile)));
  }
  return vertexClients.get(cacheKey);
}

function profileCacheKey(profile) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      projectId: profile.projectId,
      location: profile.location,
      clientEmail: profile.clientEmail,
      privateKey: profile.privateKey,
      modelsText: profile.modelsText
    }))
    .digest('hex');
  return `${profile.id}:${hash}`;
}

function profileToVertexInput(profile) {
  return {
    projectId: profile.projectId,
    location: profile.location,
    clientEmail: profile.clientEmail,
    privateKey: profile.privateKey,
    models: splitLines(profile.modelsText)
  };
}

function profileToRuntimeVertex(profile) {
  const runtime = createRuntimeConfig();
  applyRuntimeConfig(runtime, { vertex: profileToVertexInput(profile) });
  return runtime.vertex;
}

function requireUiAuth(req, res, next) {
  const session = database.getSession(readSessionCookie(req));
  if (!session) {
    return res.status(401).json({ error: { message: 'Login required' } });
  }
  req.user = { username: session.username };
  next();
}

function readSessionCookie(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
  return cookies.gemini_proxy_session || '';
}

function setSessionCookie(res, token, expiresAt) {
  res.setHeader('Set-Cookie', [
    `gemini_proxy_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', ['gemini_proxy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const webDist = path.join(rootDir, 'web/dist');
app.use(express.static(webDist));
app.get('/', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), (error) => {
    if (error) {
      res.type('html').send('<h1>Gemini OpenAI Proxy</h1><p>Run npm run build:web to build the Vue UI.</p>');
    }
  });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: {
      message: error.message || 'Internal server error',
      type: status === 401 ? 'authentication_error' : 'api_error',
      details: error.details
    }
  });
});

app.listen(port, host, () => {
  console.log(`Gemini OpenAI proxy listening on http://${host}:${port}`);
  console.log('Open the web UI to enter Vertex AI settings.');
  if (proxyUrl) console.log(`Using proxy ${proxyUrl}`);
});
