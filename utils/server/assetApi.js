import crypto from 'crypto';

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

const formatAmzDate = (date) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    shortDate: iso.slice(0, 8),
  };
};

const encodeQueryValue = (value) =>
  encodeURIComponent(String(value)).replace(/\+/g, '%20').replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const normalizeQuery = (params) => {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeQueryValue(key)}=${encodeQueryValue(params[key])}`)
    .join('&');
};

export const getAssetApiConfig = () => {
  const region = String(process.env.REGION || '').trim();
  const service = String(process.env.SERVICE || '').trim();
  const version = String(process.env.VERSION || '').trim();
  const baseUrl = String(process.env.BASE_URL || '').trim();
  const terminal = String(process.env.TERMINAL || '').trim();
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS);
  const pollMaxAttempts = Number(process.env.POLL_MAX_ATTEMPTS);

  if (!region || !service || !version || !baseUrl || !terminal) {
    throw new Error('Asset API config is incomplete. Set REGION, SERVICE, VERSION, BASE_URL, and TERMINAL in .env.local.');
  }

  if (!Number.isFinite(pollIntervalMs) || !Number.isFinite(pollMaxAttempts)) {
    throw new Error('Asset polling config is invalid. Set POLL_INTERVAL_MS and POLL_MAX_ATTEMPTS in .env.local.');
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const host = new URL(normalizedBaseUrl).host;

  return {
    region,
    service,
    version,
    baseUrl: `${normalizedBaseUrl}/`,
    terminal,
    pollIntervalMs,
    pollMaxAttempts,
    host,
  };
};

const signRequest = ({ action, payload, accessKey, secretKey }) => {
  const assetApiConfig = getAssetApiConfig();
  const payloadText = JSON.stringify(payload || {});
  const payloadHash = sha256Hex(payloadText);
  const { amzDate, shortDate } = formatAmzDate(new Date());
  const canonicalQuery = normalizeQuery({
    Action: action,
    Version: assetApiConfig.version,
  });

  const canonicalHeaders = [
    'content-type:application/json',
    `host:${assetApiConfig.host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${amzDate}`,
  ].join('\n') + '\n';

  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${shortDate}/${assetApiConfig.region}/${assetApiConfig.service}/${assetApiConfig.terminal}`;
  const stringToSign = [
    'HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(Buffer.from(secretKey, 'utf8'), shortDate),
        assetApiConfig.region
      ),
      assetApiConfig.service
    ),
    assetApiConfig.terminal
  );
  const signature = hmac(signingKey, stringToSign, 'hex');

  return {
    url: `${assetApiConfig.baseUrl}?${canonicalQuery}`,
    body: payloadText,
    headers: {
      'Content-Type': 'application/json',
      Host: assetApiConfig.host,
      'X-Date': amzDate,
      'X-Content-Sha256': payloadHash,
      Authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

export const callAssetApi = async ({ action, payload, accessKey, secretKey }) => {
  const signed = signRequest({ action, payload, accessKey, secretKey });
  const response = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  const data = await response.json();
  const serviceError = data?.ResponseMetadata?.Error;
  if (!response.ok || serviceError) {
    throw new Error(serviceError?.Message || data?.error?.message || `${action} failed: ${response.status}`);
  }
  return data;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 0 : ms));
