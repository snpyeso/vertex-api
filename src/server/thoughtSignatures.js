const MAX_SIGNATURES = 1000;
const toolCallSignatures = new Map();
const toolNameSignatures = new Map();

export function rememberToolCallSignature(id, signature, name = '') {
  if (!signature) return;

  if (id) {
    toolCallSignatures.set(String(id), signature);
  }

  if (name) {
    toolNameSignatures.set(String(name), signature);
  }

  while (toolCallSignatures.size > MAX_SIGNATURES) {
    const oldestKey = toolCallSignatures.keys().next().value;
    toolCallSignatures.delete(oldestKey);
  }
}

export function getToolCallSignature(id) {
  return id ? toolCallSignatures.get(String(id)) || '' : '';
}

export function getToolNameSignature(name) {
  return name ? toolNameSignatures.get(String(name)) || '' : '';
}
