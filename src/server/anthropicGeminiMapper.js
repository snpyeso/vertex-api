import { sanitizeGeminiSchema } from './schema.js';

function textFromAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n');
}

function parseToolResultContent(content) {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return { content };
    }
  }

  if (Array.isArray(content)) {
    return {
      content: content
        .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
        .join('\n')
    };
  }

  return content || {};
}

export function anthropicToGemini(request, modelOverrides = {}) {
  const contents = [];
  const toolUseNames = new Map();

  for (const message of request.messages || []) {
    if (message.role === 'assistant') {
      const parts = [];
      const text = textFromAnthropicContent(message.content);
      if (text) parts.push({ text });

      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item.type !== 'tool_use') continue;
        toolUseNames.set(item.id, item.name);
        parts.push({
          functionCall: {
            name: item.name,
            args: item.input || {}
          }
        });
      }

      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const toolResults = Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'tool_result')
      : [];

    if (toolResults.length > 0) {
      contents.push({
        role: 'user',
        parts: toolResults.map((result) => ({
          functionResponse: {
            name: toolUseNames.get(result.tool_use_id) || result.name || result.tool_use_id || 'tool_result',
            response: parseToolResultContent(result.content)
          }
        }))
      });
      continue;
    }

    const text = textFromAnthropicContent(message.content);
    if (text) contents.push({ role: 'user', parts: [{ text }] });
  }

  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop_sequences
    }
  };

  const systemText = textFromAnthropicContent(request.system);
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const functionDeclarations = (request.tools || [])
    .filter((tool) => tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiSchema(tool.input_schema)
    }));

  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }

  if (request.tool_choice) {
    body.toolConfig = buildToolConfig(request.tool_choice, functionDeclarations);
  }

  mergeDeep(body, modelOverrides);
  stripUndefined(body);
  return body;
}

function buildToolConfig(toolChoice, functionDeclarations) {
  if (toolChoice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name]
      }
    };
  }
  if (functionDeclarations.length > 0) return { functionCallingConfig: { mode: 'AUTO' } };
  return undefined;
}

export function geminiToAnthropic(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = (candidate.content?.parts || []).filter((part) => !part.thought);
  const content = [];

  for (const part of parts) {
    if (part.text) {
      content.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      });
    }
  }

  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: content.some((part) => part.type === 'tool_use') ? 'tool_use' : mapStopReason(candidate.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: gemini.usageMetadata?.promptTokenCount || 0,
      output_tokens: gemini.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

export function geminiChunkParts(gemini) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = (candidate.content?.parts || []).filter((part) => !part.thought);
  return {
    text: parts.map((part) => part.text).filter(Boolean).join(''),
    functionCalls: parts.map((part) => part.functionCall).filter(Boolean),
    finishReason: candidate.finishReason ? mapStopReason(candidate.finishReason) : null
  };
}

function mapStopReason(reason) {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'stop_sequence';
  return 'end_turn';
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function stripUndefined(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    } else {
      stripUndefined(value[key]);
    }
  }
}
