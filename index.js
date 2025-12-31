const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '30mb' }));

const fetchFn = globalThis.fetch;
if (typeof fetchFn !== 'function') {
  throw new Error('Global fetch is not available. Please run on Node.js >= 18.');
}

function normalizeRemoteUrl(input) {
  if (input == null) return null;
  const s = String(input);
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, '');
}

function assertAllowedRemoteUrl(urlString) {
  const uri = new URL(urlString);
  if (uri.protocol !== 'https:') {
    throw new Error(`Only https URLs are allowed: ${urlString}`);
  }
  const host = String(uri.hostname || '').toLowerCase();
  const allowed = host === 'res.cloudinary.com' || host.endsWith('.cloudinary.com');
  if (!allowed) {
    throw new Error(`Remote URL host not allowed: ${host}`);
  }
}

function normalizeBase64(b64) {
  if (!b64) return null;
  const s = String(b64).trim();
  if (!s) return null;
  if (s.startsWith('data:')) {
    const idx = s.indexOf(',');
    if (idx >= 0) return s.slice(idx + 1);
  }
  return s;
}

function asImageDataUri(b64) {
  const raw = normalizeBase64(b64);
  if (!raw) return null;
  return `data:image/jpeg;base64,${raw}`;
}

async function downloadRemoteImageAsBase64(urlString, label) {
  const normalized = normalizeRemoteUrl(urlString);
  if (!normalized) throw new Error(`Missing ${label} URL`);
  assertAllowedRemoteUrl(normalized);

  const controller = new AbortController();
  const timeoutMs = Number.parseInt(process.env.HTTP_DOWNLOAD_TIMEOUT_MS || '45000', 10);
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 45000;
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  try {
    const resp = await fetchFn(normalized, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (KYC Mini Backend)',
        Accept: 'image/*',
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} while downloading ${label}: ${body}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (e) {
    if (String(e?.name || '').toLowerCase().includes('abort')) {
      throw new Error(`Timed out downloading ${label} from ${normalized}`);
    }
    throw new Error(`Could not download ${label} from ${normalized}: ${e?.message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function kycBaseUrl() {
  const base = String(process.env.KYC_API_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    throw new Error('KYC_API_URL is required (example: http://127.0.0.1:7860 or https://xxxx.hf.space)');
  }
  return base;
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeoutMs = Number.parseInt(process.env.KYC_ENGINE_TIMEOUT_MS || '60000', 10);
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 60000;
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    return { ok: resp.ok, status: resp.status, data: parsed };
  } catch (e) {
    if (String(e?.name || '').toLowerCase().includes('abort')) {
      throw new Error(`KYC engine timed out after ${resolvedTimeoutMs}ms for ${url}`);
    }
    throw new Error(`KYC engine fetch failed for ${url}: ${e?.message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/__version', (req, res) => {
  res.json({
    service: 'kyc-mini-backend',
    time: new Date().toISOString(),
    hasKycApiUrl: Boolean(process.env.KYC_API_URL && String(process.env.KYC_API_URL).trim().length > 0),
    kycApiUrl: process.env.KYC_API_URL || null,
  });
});

app.post('/verify-cnic', async (req, res) => {
  try {
    const input = req.body || {};

    let image = normalizeBase64(input.image || input.cnicFrontBase64 || input.cnicFrontImageBase64);
    const imageUrl = input.cnicFrontUrl || input.imageUrl || input.cnicImageUrl || null;

    if (!image && imageUrl) {
      image = normalizeBase64(await downloadRemoteImageAsBase64(imageUrl, 'CNIC image'));
    }

    if (!image) {
      return res.status(400).json({ error: 'Missing CNIC image. Provide "image" (base64) or "cnicFrontUrl" (Cloudinary https URL).' });
    }

    const upstream = await postJson(`${kycBaseUrl()}/verify-cnic`, {
      image,
      imageDataUri: asImageDataUri(image),
    });

    return res.status(upstream.status).json(upstream.data);
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/face-verify', async (req, res) => {
  try {
    const input = req.body || {};

    let image1 = normalizeBase64(input.image1 || input.img1);
    let image2 = normalizeBase64(input.image2 || input.img2);

    const image1Url = input.image1Url || input.cnicImageUrl || null;
    const image2Url = input.image2Url || input.selfieImageUrl || null;

    if (!image1 && image1Url) {
      image1 = normalizeBase64(await downloadRemoteImageAsBase64(image1Url, 'CNIC image'));
    }
    if (!image2 && image2Url) {
      image2 = normalizeBase64(await downloadRemoteImageAsBase64(image2Url, 'selfie image'));
    }

    if (!image1 || !image2) {
      return res.status(400).json({
        error: 'Missing face images. Provide "image1" and "image2" (base64) or "cnicImageUrl" + "selfieImageUrl" (Cloudinary https URLs).',
      });
    }

    const upstream = await postJson(`${kycBaseUrl()}/face-verify`, {
      image1,
      image2,
      image1DataUri: asImageDataUri(image1),
      image2DataUri: asImageDataUri(image2),
    });

    return res.status(upstream.status).json(upstream.data);
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/shop-verify', async (req, res) => {
  try {
    const input = req.body || {};

    let image = normalizeBase64(input.image || input.shopImage || input.shopImageBase64);
    const imageUrl = input.shopImageUrl || input.imageUrl || null;

    if (!image && imageUrl) {
      image = normalizeBase64(await downloadRemoteImageAsBase64(imageUrl, 'shop image'));
    }

    if (!image) {
      return res.status(400).json({
        error: 'Missing shop image. Provide "image" (base64) or "shopImageUrl" (Cloudinary https URL).',
      });
    }

    const upstream = await postJson(`${kycBaseUrl()}/shop-verify`, {
      image,
      imageDataUri: asImageDataUri(image),
    });

    return res.status(upstream.status).json(upstream.data);
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const port = Number.parseInt(process.env.PORT || '8085', 10);
app.listen(port, () => {
  console.log(`KYC mini backend listening on port ${port}`);
});
