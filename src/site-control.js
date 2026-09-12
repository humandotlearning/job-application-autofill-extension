const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeHostname(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text.includes('://') ? text : `https://${text}`);
    if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) return '';
    return String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function hostnameFromUrl(value) {
  return normalizeHostname(value);
}

export function normalizeHostnames(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeHostname).filter(Boolean))].sort();
}

export function isHostnameDisabled(hostname, disabledHostnames) {
  const normalized = normalizeHostname(hostname);
  return Boolean(normalized && normalizeHostnames(disabledHostnames).includes(normalized));
}

export function isSupportedSiteUrl(value) {
  try {
    return SUPPORTED_PROTOCOLS.has(new URL(value).protocol) && Boolean(normalizeHostname(value));
  } catch {
    return false;
  }
}
