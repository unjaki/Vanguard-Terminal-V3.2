import axios from 'axios';

// Use a configurable proxy domain to avoid Roblox per-IP rate limits.
// Set RBX_PROXY_DOMAIN=roblox.com to call Roblox directly (no proxy).
// Defaults to roproxy.org (subdomain-style: https://<subdomain>.roproxy.org/...)
const getProxyDomain = () => process.env['RBX_PROXY_DOMAIN'] || 'roproxy.org';

export const rbxApi = (subdomain: string, path: string): string =>
  `https://${subdomain}.${getProxyDomain()}${path}`;

export const requestWithRetry = async (
  url: string,
  options: { method?: string; data?: unknown; timeout?: number; headers?: Record<string, string> } = {},
  retries = 3,
  backoff = 2000
): Promise<{ data: unknown }> => {
  const { method = 'GET', data = null, ...axiosOptions } = options;
  for (let i = 0; i < retries; i++) {
    try {
      if (method === 'POST') {
        return await axios.post(url, data, { ...axiosOptions, timeout: axiosOptions.timeout || 10000 });
      }
      return await axios.get(url, { ...axiosOptions, timeout: axiosOptions.timeout || 10000 });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number }; message?: string };
      const status = axiosErr.response ? axiosErr.response.status : null;
      if (status === 404) throw err;
      if (i === retries - 1) throw err;

      const isRateLimit = status === 429;
      const baseDelay = isRateLimit ? Math.pow(2, i) * 6000 : backoff * (i + 1);
      const jitter = Math.random() * 2000;
      const delay = baseDelay + jitter;

      console.warn(`[RETRY] ${url} failed (Attempt ${i + 1}/${retries}). ${isRateLimit ? 'RATE LIMITED — backing off' : axiosErr.message}`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw new Error('Max retries exceeded');
};

export const fetchWithRetry = (url: string, options: Record<string, unknown> = {}, retries = 3, backoff = 1000) =>
  requestWithRetry(url, { ...options, method: 'GET' }, retries, backoff);

// Fetch outfit thumbnails in batches of 50 (Roblox API limit per request)
// with retry and pending-state resolution built in.
export const fetchOutfitThumbnails = async (outfitIds: number[]): Promise<Map<number, string>> => {
  const FALLBACK = 'https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png';
  const result = new Map<number, string>();
  const BATCH = 50;

  type ThumbEntry = { targetId: number; state: string; imageUrl: string };

  const fetchBatch = async (ids: number[]): Promise<ThumbEntry[]> => {
    const url = rbxApi('thumbnails', `/v1/users/outfits?userOutfitIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`);
    try {
      const res = await fetchWithRetry(url, {}, 4, 2000);
      return (res.data as { data: ThumbEntry[] }).data || [];
    } catch {
      return [];
    }
  };

  // Process in batches
  for (let i = 0; i < outfitIds.length; i += BATCH) {
    const batchIds = outfitIds.slice(i, i + BATCH);
    let thumbs = await fetchBatch(batchIds);

    // If more than half are still pending, wait and retry once
    const pending = thumbs.filter(t => t.state !== 'Completed');
    if (pending.length > batchIds.length / 2) {
      console.log(`[OUTFITS] ${pending.length}/${batchIds.length} pending — waiting 3s then retrying`);
      await new Promise(r => setTimeout(r, 3000));
      thumbs = await fetchBatch(batchIds);
    }

    thumbs.forEach(t => {
      result.set(t.targetId, t.state === 'Completed' && t.imageUrl ? t.imageUrl : FALLBACK);
    });

    // Stagger batches slightly to reduce rate limit pressure
    if (i + BATCH < outfitIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return result;
};
