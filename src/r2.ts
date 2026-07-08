// Cliente R2 (S3-compatível) para o Obsidian.
// Assina no padrão AWS SigV4 usando crypto.subtle e faz as requisições via
// `requestUrl` do Obsidian (funciona no desktop E no mobile, sem CORS).
import { requestUrl, type RequestUrlResponse } from 'obsidian';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string; // normalizado com barra no fim (ou vazio)
  region: string; // "auto" no R2
}

export interface R2Object {
  key: string;
  size: number;
}

const enc = new TextEncoder();
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
  return toHex(await crypto.subtle.digest('SHA-256', buf as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, enc.encode(data) as BufferSource);
}

// Codificação de URI no padrão AWS (RFC 3986). encodeSlash=false preserva '/'.
function awsUriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const byte of enc.encode(str)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9_\-~.]/.test(c)) out += c;
    else if (c === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function amzDates(): { amzDate: string; dateStamp: string } {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export class R2Client {
  constructor(private cfg: R2Config) {}

  get host(): string {
    return `${this.cfg.accountId}.r2.cloudflarestorage.com`;
  }

  private async signAndSend(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: ArrayBuffer | string; contentType?: string } = {},
  ): Promise<RequestUrlResponse> {
    const { cfg } = this;
    const { query = {}, body, contentType } = opts;
    const { amzDate, dateStamp } = amzDates();

    const canonicalUri = '/' + cfg.bucket + (key ? '/' + awsUriEncode(key, false) : '');
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k])}`)
      .join('&');

    const payloadHash = body != null ? await sha256Hex(body) : EMPTY_SHA256;

    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmac(enc.encode('AWS4' + cfg.secretAccessKey), dateStamp);
    const kRegion = await hmac(kDate, cfg.region);
    const kService = await hmac(kRegion, 's3');
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, stringToSign));

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url =
      `https://${this.host}` + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : '');

    const res = await requestUrl({
      url,
      method,
      headers: { ...headers, authorization },
      body,
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const msg = (res.text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || `HTTP ${res.status}`;
      throw new Error(`R2 ${method} ${key || '(bucket)'} -> ${res.status}: ${msg}`);
    }
    return res;
  }

  async testConnection(): Promise<void> {
    await this.signAndSend('GET', '', { query: { 'list-type': '2', 'max-keys': '1' } });
  }

  async list(subPrefix = ''): Promise<R2Object[]> {
    const prefix = this.cfg.prefix + subPrefix;
    const out: R2Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
      if (prefix) query['prefix'] = prefix;
      if (token) query['continuation-token'] = token;
      const res = await this.signAndSend('GET', '', { query });
      const xml = res.text;
      const re = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) out.push({ key: m[1], size: Number(m[2]) });
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      token = truncated && next ? next[1] : undefined;
    } while (token);
    return out;
  }

  async getText(key: string): Promise<string> {
    const res = await this.signAndSend('GET', this.cfg.prefix + key);
    return res.text;
  }

  async getBinary(key: string): Promise<ArrayBuffer> {
    const res = await this.signAndSend('GET', this.cfg.prefix + key);
    return res.arrayBuffer;
  }

  async put(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const ct =
      contentType ||
      (key.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
    await this.signAndSend('PUT', this.cfg.prefix + key, { body, contentType: ct });
  }

  async del(key: string): Promise<void> {
    await this.signAndSend('DELETE', this.cfg.prefix + key);
  }

  stripPrefix(absKey: string): string {
    const p = this.cfg.prefix;
    return p && absKey.startsWith(p) ? absKey.slice(p.length) : absKey;
  }
}
