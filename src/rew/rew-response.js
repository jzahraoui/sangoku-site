function safeParseJSON(str) {
  if (!str || typeof str !== 'string') {
    return null;
  }
  const trimmed = str.trim();
  if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
    return null;
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function mergeParsedMessage(data) {
  if (!data || typeof data !== 'object') return;
  if (typeof data.message !== 'string') return;

  const parsed = safeParseJSON(data.message);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    Object.assign(data, parsed);
  }
}

function extractErrorMessage(data) {
  if (!data || typeof data !== 'object') return null;
  return data.results?.[0]?.Error || null;
}

export { extractErrorMessage, mergeParsedMessage, safeParseJSON };

export const responseStatics = {
  extractErrorMessage,
  mergeParsedMessage,
  safeParseJSON,
};
