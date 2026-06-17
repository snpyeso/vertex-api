import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRuntimeConfig, assertApiKey, assertConfigured, createRuntimeConfig, publicConfig } from './config.js';
import { anthropicToGemini, geminiChunkParts as anthropicChunkParts, geminiToAnthropic } from './anthropicGeminiMapper.js';
import { geminiChunkParts as openAiChunkParts, openAiToGemini, geminiToOpenAi } from './openaiGeminiMapper.js';
import { VertexClient } from './vertexClient.js';
import { configureProxy, getCurrentProxyUrl } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const config = createRuntimeConfig();
let proxyUrl = configureProxy();
let vertexClient = null;
const app = express();
const port = Number(process.env.PORT || 3100);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

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

app.get('/config', (_req, res) => {
  res.json(publicConfig(config));
});

app.post('/config', (req, res, next) => {
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
    assertConfigured(config);
    assertApiKey(config, req.headers.authorization);
    res.json({
      object: 'list',
      data: config.vertex.models.map((model) => ({
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
  try {
    assertConfigured(config);
    assertApiKey(config, req.headers.authorization);

    const model = req.body.model || config.vertex.models[0];
    if (!config.vertex.models.includes(model)) {
      return res.status(400).json({
        error: {
          message: `Model '${model}' is not configured`,
          type: 'invalid_request_error'
        }
      });
    }

    const overrides = config.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
    const vertexBody = openAiToGemini(req.body, overrides);
    if (req.body.stream) {
      return streamOpenAiResponse(res, model, vertexClient.streamGenerateContent(model, vertexBody));
    }

    const vertexResponse = await vertexClient.generateContent(model, vertexBody);
    res.json(geminiToOpenAi(vertexResponse, model));
  } catch (error) {
    next(error);
  }
});

app.post('/v1/messages', async (req, res, next) => {
  try {
    assertConfigured(config);
    assertApiKey(config, req.headers.authorization || req.headers['x-api-key']);

    const model = req.body.model || config.vertex.models[0];
    if (!config.vertex.models.includes(model)) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `Model '${model}' is not configured`
        }
      });
    }

    const overrides = config.vertex.preferences?.post_body_parameter_overrides?.[model] || {};
    const vertexBody = anthropicToGemini(req.body, overrides);
    if (req.body.stream) {
      return streamAnthropicResponse(res, model, vertexClient.streamGenerateContent(model, vertexBody));
    }

    const vertexResponse = await vertexClient.generateContent(model, vertexBody);
    res.json(geminiToAnthropic(vertexResponse, model));
  } catch (error) {
    next(error);
  }
});

async function streamOpenAiResponse(res, model, stream) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let finished = false;

  setSseHeaders(res);

  try {
    for await (const geminiChunk of stream) {
      if (!sentRole) {
        writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        });
        sentRole = true;
      }

      const chunk = openAiChunkParts(geminiChunk);
      if (chunk.text) {
        writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }]
        });
      }

      for (const [index, call] of chunk.functionCalls.entries()) {
        writeSseData(res, {
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
                    id: `call_${index}_${crypto.randomUUID().replaceAll('-', '')}`,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args || {})
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
      }

      if (chunk.finishReason) {
        writeSseData(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: chunk.functionCalls.length ? 'tool_calls' : chunk.finishReason }]
        });
        finished = true;
      }
    }

    if (!finished) {
      writeSseData(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    writeSseData(res, { error: { message: error.message, type: 'api_error', details: error.details } });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function streamAnthropicResponse(res, model, stream) {
  const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let contentIndex = 0;
  let textBlockOpen = false;
  let stopReason = 'end_turn';

  setSseHeaders(res);
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
      const chunk = anthropicChunkParts(geminiChunk);
      if (chunk.text) {
        if (!textBlockOpen) {
          writeSseEvent(res, 'content_block_start', {
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'text', text: '' }
          });
          textBlockOpen = true;
        }
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'text_delta', text: chunk.text }
        });
      }

      for (const call of chunk.functionCalls) {
        if (textBlockOpen) {
          writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex });
          contentIndex += 1;
          textBlockOpen = false;
        }

        writeSseEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: {
            type: 'tool_use',
            id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
            name: call.name,
            input: {}
          }
        });
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args || {}) }
        });
        writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex });
        contentIndex += 1;
        stopReason = 'tool_use';
      }

      if (chunk.finishReason && stopReason !== 'tool_use') {
        stopReason = chunk.finishReason;
      }
    }

    if (textBlockOpen) {
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex });
    }
    writeSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 }
    });
    writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } catch (error) {
    writeSseEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: error.message }
    });
    res.end();
  }
}

function setSseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeSseData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  writeSseData(res, data);
}

const webDist = path.join(rootDir, 'web/dist');
app.use(express.static(webDist));
app.get('/', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), (error) => {
    if (error) {
      res.type('html').send('<h1>Gemini OpenAI Proxy</h1><p>Run npm.cmd run build:web to build the Vue UI.</p>');
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

app.listen(port, () => {
  console.log(`Gemini OpenAI proxy listening on http://localhost:${port}`);
  console.log('Open the web UI to enter Vertex AI settings.');
  if (proxyUrl) console.log(`Using proxy ${proxyUrl}`);
});
