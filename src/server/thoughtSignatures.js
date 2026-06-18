const MAX_SIGNATURES = 1000;
const toolCallSignatures = new Map();

export function rememberToolCallSignature(id, signature) {
  if (!id || !signature) return;
  toolCallSignatures.set(String(id), signature);

  while (toolCallSignatures.size > MAX_SIGNATURES) {
    const oldestKey = toolCallSignatures.keys().next().value;
    toolCallSignatures.delete(oldestKey);
  }
}

export function getToolCallSignature(id) {
  return id ? toolCallSignatures.get(String(id)) || '' : '';
}
