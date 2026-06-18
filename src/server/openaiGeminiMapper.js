import { sanitizeGeminiSchema } from './schema.js';
import { getToolCallSignature, getToolNameSignature, rememberToolCallSignature } from './thoughtSignatures.js';

function asTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === 'text') return part.text || '';
        if (part.type === 'input_text') return part.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function parseToolArguments(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;

  try {
    return JSON.parse(args);
  } catch {
    return { value: args };
  }
}

function readThoughtSignature(value) {
  return (
    value?.extra_content?.google?.thought_signature ||
    value?.extra_content?.google?.thoughtSignature ||
    value?.thoughtSignature ||
    value?.thought_signature ||
    value?.function?.thoughtSignature ||
    value?.function?.thought_signature ||
    getToolCallSignature(value?.id) ||
    getToolNameSignature(value?.function?.name) ||
    ''
  );
}

function functionCallPart(functionCall, thoughtSignature) {
  const part = { functionCall };
  if (thoughtSignature) part.thoughtSignature = thoughtSignature;
  return part;
}

function functionCallPartsWithSignatures(parts) {
  let lastThoughtSignature = '';
  const functionCallParts = [];

  for (const part of parts || []) {
    if (part.thoughtSignature) {
      lastThoughtSignature = part.thoughtSignature;
    }
    if (part.functionCall) {
      functionCallParts.push({
        ...part,
        thoughtSignature: part.thoughtSignature || lastThoughtSignature
      });
    }
  }

  return functionCallParts;
}

export function openAiToGemini(request, modelOverrides = {}) {
  const systemTexts = [];
  const contents = [];
  const toolCallNames = new Map();

  for (const message of request.messages || []) {
    if (message.role === 'system') {
      const text = asTextContent(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (message.role === 'assistant') {
      const parts = [];
      const text = asTextContent(message.content);
      if (text) parts.push({ text });

      for (const toolCall of message.tool_calls || []) {
        if (toolCall.type !== 'function') continue;
        if (toolCall.id) toolCallNames.set(toolCall.id, toolCall.function.name);
        parts.push(
          functionCallPart(
            {
            name: toolCall.function.name,
            args: parseToolArguments(toolCall.function.arguments)
            },
            readThoughtSignature(toolCall)
          )
        );
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      continue;
    }

    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name || toolCallNames.get(message.tool_call_id) || message.tool_call_id || 'tool_result',
              response: parseToolArguments(message.content)
            }
          }
        ]
      });
      continue;
    }

    const text = asTextContent(message.content);
    if (text) {
      contents.push({ role: 'user', parts: [{ text }] });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined
    }
  };

  if (systemTexts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }

  const functionDeclarations = (request.tools || [])
    .filter((tool) => tool.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: sanitizeGeminiSchema(tool.function.parameters)
    }));

  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }

  if (request.tool_choice && request.tool_choice !== 'auto') {
    body.toolConfig = buildToolConfig(request.tool_choice, functionDeclarations);
  }

  mergeDeep(body, modelOverrides);
  stripUndefined(body);
  return body;
}

function buildToolConfig(toolChoice, functionDeclarations) {
  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }

  if (toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }

  const name = toolChoice?.function?.name;
  if (name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [name]
      }
    };
  }

  if (functionDeclarations.length > 0) {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  return undefined;
}

export function geminiToOpenAi(gemini, requestModel) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const visibleParts = parts.filter((part) => !part.thought);
  const text = visibleParts.map((part) => part.text).filter(Boolean).join('');
  const functionCallParts = functionCallPartsWithSignatures(parts);
  const hasToolCalls = functionCallParts.length > 0;

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: hasToolCalls
            ? functionCallParts.map((part, index) => openAiToolCall(part, index))
            : undefined
        },
        finish_reason: hasToolCalls ? 'tool_calls' : mapFinishReason(candidate.finishReason)
      }
    ],
    usage: {
      prompt_tokens: gemini.usageMetadata?.promptTokenCount || 0,
      completion_tokens: gemini.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: gemini.usageMetadata?.totalTokenCount || 0
    }
  };
}

function openAiToolCall(part, index) {
  const id = `call_${index}_${crypto.randomUUID().replaceAll('-', '')}`;
  rememberToolCallSignature(id, part.thoughtSignature, part.functionCall.name);
  return {
    id,
    type: 'function',
    extra_content: part.thoughtSignature ? { google: { thought_signature: part.thoughtSignature } } : undefined,
    thought_signature: part.thoughtSignature,
    thoughtSignature: part.thoughtSignature,
    function: {
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args || {}),
      thought_signature: part.thoughtSignature,
      thoughtSignature: part.thoughtSignature
    }
  };
}

export function geminiChunkParts(gemini) {
  const candidate = gemini.candidates?.[0] || {};
  const parts = (candidate.content?.parts || []).filter((part) => !part.thought);
  return {
    text: parts.map((part) => part.text).filter(Boolean).join(''),
    functionCalls: functionCallPartsWithSignatures(candidate.content?.parts || [])
      .map((part) => ({
        ...part.functionCall,
        thoughtSignature: part.thoughtSignature,
        thought_signature: part.thoughtSignature
      })),
    finishReason: candidate.finishReason ? mapFinishReason(candidate.finishReason) : null
  };
}

function mapFinishReason(reason) {
  if (!reason || reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
  return 'stop';
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
