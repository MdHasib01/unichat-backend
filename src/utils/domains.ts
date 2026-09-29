/**
 * Allowed-domain matching for the website chat widget.
 *
 * Entries are hostnames ("shop.example.com"), wildcards ("*.example.com",
 * which also matches the bare "example.com"), or may be pasted as full URLs —
 * they are normalized first. An empty list allows every site.
 */

export function normalizeDomain(entry: string): string | null {
  let value = entry.trim().toLowerCase();
  if (!value) return null;
  const wildcard = value.startsWith('*.');
  if (wildcard) value = value.slice(2);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].split(':')[0];
  if (!/^[a-z0-9.-]+$/.test(value) || (!value.includes('.') && value !== 'localhost')) return null;
  return wildcard ? `*.${value}` : value;
}

export function hostFromOrigin(origin: string | undefined | null): string | null {
  if (!origin || origin === 'null') return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin: string | undefined | null, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true;
  const host = hostFromOrigin(origin);
  if (!host) return false;

  return allowedDomains.some((raw) => {
    const entry = normalizeDomain(raw);
    if (!entry) return false;
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === entry;
  });
}
