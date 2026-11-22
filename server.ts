import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = 3000;
const GOGO_BASE = 'https://gogoanime.or.at';

const app = express();
app.use(express.json());

// In-memory cache for ultra-fast response & reduced source load
const cache = new Map<string, { data: any; expiry: number }>();
function getCached<T>(key: string): T | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiry) {
    cache.delete(key);
    return null;
  }
  return cached.data as T;
}
function setCached(key: string, data: any, ttlSec: number = 300) {
  cache.set(key, { data, expiry: Date.now() + ttlSec * 1000 });
}

// Request helper with headers
async function fetchHtml(targetUrl: string): Promise<string> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': GOGO_BASE,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(targetUrl, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Fetch failed with status ${res.status} for ${targetUrl}`);
    }
    return await res.text();
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Helper to extract clean slug from URL
function extractSlug(url: string, prefix = ''): string {
  if (!url) return '';
  const clean = url.replace(GOGO_BASE, '').replace(/^\/+|\/+$/g, '');
  if (prefix && clean.startsWith(prefix)) {
    return clean.slice(prefix.length).replace(/^\/+|\/+$/g, '');
  }
  return clean;
}

// Parse anime cards from .bsx elements
function parseAnimeCards($: cheerio.CheerioAPI, selector = '.bsx'): any[] {
  const items: any[] = [];
  $(selector).each((_, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    if (!href) return;

    const title = $(el).find('.tt h2').text().trim() || $(el).find('.tt').text().trim();
    const episode = $(el).find('.bt .epx').text().trim();
    const subType = $(el).find('.bt .sb').text().trim() || 'Sub';
    const type = $(el).find('.typez').text().trim() || 'TV';
    const image = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
    const rating = $(el).find('.rating strong, .num').text().trim();

    const isEpisode = href.includes('-episode-') && !href.includes('/anime/');
    const slug = isEpisode ? extractSlug(href) : extractSlug(href, 'anime');

    items.push({
      title,
      slug,
      href,
      episode,
      subType,
      type,
      image,
      rating: rating || undefined,
      isEpisode,
    });
  });
  return items;
}

// 1. Recent episode updates
app.get('/api/anime/recent', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const cacheKey = `recent_page_${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const targetUrl = page > 1 ? `${GOGO_BASE}/page/${page}/` : `${GOGO_BASE}/`;
    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const items = parseAnimeCards($, '.bsx');

    // Check pagination
    const hasNext = $('.hpage a.r, .pagination a.next, .pagination .next').length > 0;
    const result = { items, page, hasNext };
    setCached(cacheKey, result, 180); // cache for 3 mins
    return res.json(result);
  } catch (error: any) {
    console.error('Error fetching recent anime:', error.message);
    return res.status(500).json({ error: 'Failed to fetch recent episodes', message: error.message, items: [] });
  }
});

// 2. Popular anime series
app.get('/api/anime/popular', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const cacheKey = `popular_page_${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const targetUrl = `${GOGO_BASE}/anime/?page=${page}&order=popular`;
    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const items = parseAnimeCards($, '.bsx');
    const hasNext = $('.hpage a.r, .pagination a.next').length > 0;
    const result = { items, page, hasNext };
    setCached(cacheKey, result, 600); // 10 mins cache
    return res.json(result);
  } catch (error: any) {
    console.error('Error fetching popular anime:', error.message);
    return res.status(500).json({ error: 'Failed to fetch popular anime', message: error.message, items: [] });
  }
});

// 3. Directory / Catalog with multi-filters
app.get('/api/anime/directory', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const order = (req.query.order as string) || 'popular'; // popular, update, latest, rating, title, titlereverse
    const status = (req.query.status as string) || ''; // ongoing, completed, upcoming, hiatus
    const type = (req.query.type as string) || ''; // tv, movie, ova, special, ona, bd
    const sub = (req.query.sub as string) || ''; // sub, dub, raw
    const genre = (req.query.genre as string) || '';

    const cacheKey = `dir_${page}_${order}_${status}_${type}_${sub}_${genre}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const params = new URLSearchParams();
    if (page > 1) params.append('page', page.toString());
    if (order) params.append('order', order);
    if (status) params.append('status', status);
    if (type) params.append('type', type);
    if (sub) params.append('sub', sub);
    if (genre) params.append('genre[]', genre);

    const targetUrl = `${GOGO_BASE}/anime/?${params.toString()}`;
    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const items = parseAnimeCards($, '.bsx');
    const hasNext = $('.hpage a.r, .pagination a.next').length > 0;

    const result = { items, page, hasNext, filters: { order, status, type, sub, genre } };
    setCached(cacheKey, result, 300);
    return res.json(result);
  } catch (error: any) {
    console.error('Error fetching directory:', error.message);
    return res.status(500).json({ error: 'Failed to fetch directory', message: error.message, items: [] });
  }
});

// 4. Search anime
app.get('/api/anime/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    const page = parseInt(req.query.page as string, 10) || 1;
    if (!q) {
      return res.json({ items: [], page: 1, hasNext: false });
    }

    const cacheKey = `search_${q.toLowerCase()}_${page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const targetUrl = page > 1 
      ? `${GOGO_BASE}/page/${page}/?s=${encodeURIComponent(q)}`
      : `${GOGO_BASE}/?s=${encodeURIComponent(q)}`;

    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const items = parseAnimeCards($, '.bsx');
    const hasNext = $('.hpage a.r, .pagination a.next').length > 0;

    const result = { items, page, query: q, hasNext };
    setCached(cacheKey, result, 300);
    return res.json(result);
  } catch (error: any) {
    console.error('Error searching anime:', error.message);
    return res.status(500).json({ error: 'Failed to search anime', message: error.message, items: [] });
  }
});

// 5. Anime series details & full episode list
app.get('/api/anime/details', async (req: Request, res: Response) => {
  try {
    let slug = (req.query.slug as string || '').trim();
    const url = (req.query.url as string || '').trim();

    if (!slug && !url) {
      return res.status(400).json({ error: 'slug or url required' });
    }

    let targetUrl = '';
    if (url && url.startsWith('http')) {
      targetUrl = url;
      slug = extractSlug(url, 'anime');
    } else {
      // Clean slug
      slug = slug.replace(/^\/+|\/+$/g, '').replace(/^anime\//, '');
      targetUrl = `${GOGO_BASE}/anime/${slug}/`;
    }

    const cacheKey = `details_${slug}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const title = $('h1.entry-title').text().trim() || $('title').text().replace('- Gogoanime', '').trim();
    const poster = $('.thumb img').attr('src') || $('.infox img').attr('src') || $('img.wp-post-image').attr('src') || '';
    const synopsis = $('.entry-content[itemprop="description"] p').text().trim() || $('.entry-content p').text().trim();
    
    // Rating
    const ratingText = $('.rating strong, .num').first().text().trim();
    const rating = ratingText.replace(/[^0-9.]/g, '') || undefined;

    // Genres
    const genres: string[] = [];
    $('.genxed a').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    // Metadata specs (Status, Studio, Season, Type, Released, etc.)
    const metadata: Record<string, string> = {};
    $('.spe span').each((_, el) => {
      const text = $(el).text();
      const parts = text.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join(':').trim();
        metadata[key] = value;
      }
    });

    // Episodes list
    const episodes: any[] = [];
    $('.eplister ul li').each((_, el) => {
      const a = $(el).find('a');
      const href = a.attr('href') || '';
      const num = $(el).find('.epl-num').text().trim();
      const epTitle = $(el).find('.epl-title').text().trim();
      const date = $(el).find('.epl-date').text().trim();
      const sub = $(el).find('.epl-sub').text().trim() || 'Sub';
      const epSlug = extractSlug(href);

      if (href) {
        episodes.push({
          number: num,
          title: epTitle || `Episode ${num}`,
          date,
          sub,
          href,
          slug: epSlug,
        });
      }
    });

    const result = {
      title,
      slug,
      href: targetUrl,
      poster,
      synopsis,
      rating,
      genres,
      status: metadata['status'] || 'Unknown',
      studio: metadata['studio'] || metadata['studios'] || 'Unknown',
      released: metadata['released'] || metadata['released on'] || metadata['season'] || 'Unknown',
      type: metadata['type'] || 'TV',
      duration: metadata['duration'] || '24 min',
      season: metadata['season'] || undefined,
      totalEpisodes: episodes.length,
      episodes,
    };

    setCached(cacheKey, result, 600); // 10 min cache
    return res.json(result);
  } catch (error: any) {
    console.error('Error fetching anime details:', error.message);
    return res.status(500).json({ error: 'Failed to fetch anime details', message: error.message });
  }
});

// 6. Episode details & stream servers
app.get('/api/anime/episode', async (req: Request, res: Response) => {
  try {
    let slug = (req.query.slug as string || '').trim();
    const url = (req.query.url as string || '').trim();

    if (!slug && !url) {
      return res.status(400).json({ error: 'slug or url required' });
    }

    let targetUrl = '';
    if (url && url.startsWith('http')) {
      targetUrl = url;
      slug = extractSlug(url);
    } else {
      slug = slug.replace(/^\/+|\/+$/g, '');
      targetUrl = `${GOGO_BASE}/${slug}/`;
    }

    const cacheKey = `ep_${slug}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const html = await fetchHtml(targetUrl);
    const $ = cheerio.load(html);

    const title = $('h1.entry-title').text().trim() || $('title').text().replace('- Gogoanime', '').trim();

    const normalizeEmbedUrl = (rawUrl: string): string => {
      let cleaned = rawUrl.trim().replace(/&amp;/g, '&');
      if (cleaned.startsWith('//')) {
        cleaned = `https:${cleaned}`;
      }
      return cleaned;
    };

    const rawDefaultEmbed = $('#pembed iframe').attr('src') || '';
    const defaultEmbed = rawDefaultEmbed ? normalizeEmbedUrl(rawDefaultEmbed) : '';

    // Extract native sources from https://gogoanime.or.at/
    const rawServers: { name: string; url: string }[] = [];
    $('select.mirror option').each((_, opt) => {
      const val = $(opt).attr('value');
      const name = $(opt).text().trim();
      if (!val) return;
      try {
        const decoded = Buffer.from(val, 'base64').toString('utf-8');
        const match = decoded.match(/src=["']([^"']+)["']/i);
        if (match && match[1]) {
          const embedUrl = normalizeEmbedUrl(match[1]);
          if (embedUrl) {
            rawServers.push({ name: name || `Server ${rawServers.length + 1}`, url: embedUrl });
          }
        }
      } catch {
        // ignore invalid base64 option
      }
    });

    // Extract MAL ID, episode number, and dub status from gogoanime.or.at HTML
    const malMatch =
      html.match(/var\s+malId\s*=\s*['"](\d+)['"]/i) ||
      html.match(/mal_id[=:]\s*['"]?(\d+)['"]?/i) ||
      defaultEmbed.match(/mal_id=(\d+)/i);
    const malId = malMatch?.[1] || '';

    const epMatch =
      html.match(/var\s+ep\s*=\s*['"](\d+)['"]/i) ||
      slug.match(/-episode-(\d+)/i) ||
      title.match(/Episode\s+(\d+)/i) ||
      defaultEmbed.match(/ep=(\d+)/i);
    const epNum = epMatch?.[1] || '1';

    const isDub =
      slug.includes('-dub-') ||
      slug.endsWith('-dub') ||
      title.toLowerCase().includes('(dub)') ||
      html.includes('category=dub');
    const category = isDub ? 'dub' : 'sub';

    // Classify GogoAnime's native sources for ad-free HLS extraction
    const gogoPrimary =
      (defaultEmbed.includes('newplayer.php') ? defaultEmbed : '') ||
      rawServers.find((s) => s.url.includes('newplayer.php') && !s.url.includes('type=hd-2'))?.url ||
      '';
    const gogoAnimeId =
      rawServers.find((s) => s.url.includes('newplayer.php?anime-id='))?.url || '';
    const nativeVidmoly =
      (defaultEmbed.includes('vidmoly') ? defaultEmbed : '') ||
      rawServers.find((s) => s.name.toLowerCase().includes('omega') || s.url.includes('vidmoly'))?.url ||
      '';
    const nativeVidstreaming =
      rawServers.find((s) => s.name.toLowerCase().includes('vidstreaming') || s.url.includes('player.php?m3u8='))?.url ||
      '';
    const nativeMoonEmbed =
      rawServers.find(
        (s) =>
          s.name.toLowerCase().includes('moon') ||
          s.url.includes('bysesayeveum') ||
          s.url.includes('filemoon')
      )?.url || '';
    const gogoMalFallback = malId
      ? `https://gogoanime.me.uk/newplayer.php?mal_id=${malId}&ep=${epNum}&category=${category}`
      : '';

    // 1. Omega Server (Ad-free direct HLS extracted from GogoAnime primary or Vidmoly)
    const omegaUrl = gogoPrimary || nativeVidmoly || nativeVidstreaming || gogoMalFallback || defaultEmbed;

    // 2. Moon Server (Independent ad-free direct HLS mirror — Vidmoly / Vidstreaming / GogoAnime secondary)
    let moonUrl = '';
    if (nativeVidmoly && nativeVidmoly !== omegaUrl) {
      moonUrl = nativeVidmoly;
    } else if (nativeVidstreaming && nativeVidstreaming !== omegaUrl) {
      moonUrl = nativeVidstreaming;
    } else if (gogoAnimeId && gogoAnimeId !== omegaUrl) {
      moonUrl = gogoAnimeId;
    } else if (gogoMalFallback && gogoMalFallback !== omegaUrl) {
      moonUrl = gogoMalFallback;
    } else if (nativeMoonEmbed && nativeMoonEmbed !== omegaUrl) {
      moonUrl = nativeMoonEmbed;
    } else if (omegaUrl) {
      moonUrl = omegaUrl;
    }

    // ONLY Omega Server and Moon Server (HD-1 and HD-2 removed as requested)
    const servers: { name: string; url: string; isDefault?: boolean }[] = [];
    if (omegaUrl) {
      servers.push({ name: 'Omega Server', url: omegaUrl, isDefault: true });
    }
    if (moonUrl) {
      servers.push({ name: 'Moon Server', url: moonUrl });
    }

    // Navigation links
    const prevEpUrl = $('a[rel="prev"]').attr('href') || null;
    const nextEpUrl = $('a[rel="next"]').attr('href') || null;
    const allEpisodesUrl = $('.naveps .nvsc a').attr('href') || null;

    // Series title from breadcrumb or navigation
    const seriesTitle = $('.ts-breadcrumb li:nth-child(2) a').text().trim() ||
                        $('.naveps .nvsc a').attr('aria-label') ||
                        '';

    const seriesSlug = allEpisodesUrl ? extractSlug(allEpisodesUrl, 'anime') : '';

    const result = {
      title,
      slug,
      href: targetUrl,
      currentEmbed: omegaUrl || moonUrl || '',
      servers,
      prevEpisode: prevEpUrl ? { href: prevEpUrl, slug: extractSlug(prevEpUrl) } : null,
      nextEpisode: nextEpUrl ? { href: nextEpUrl, slug: extractSlug(nextEpUrl) } : null,
      series: allEpisodesUrl ? { href: allEpisodesUrl, slug: seriesSlug, title: seriesTitle } : null,
    };

    setCached(cacheKey, result, 600);
    return res.json(result);
  } catch (error: any) {
    console.error('Error fetching episode:', error.message);
    return res.status(500).json({ error: 'Failed to fetch episode details', message: error.message });
  }
});

// Helper: validate external HTTP(S) URLs to prevent SSRF against local/private networks
function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Decrypt MegaPlay encrypted source payload (AES-256-CBC) to direct ad-free HLS m3u8 URL
function decryptMegaPlayEnc(enc: string): { file: string } | null {
  try {
    const key = Buffer.alloc(32);
    Buffer.from('i?LMTAx0Q6,:}50U', 'utf8').copy(key);
    const iv = Buffer.alloc(16);
    Buffer.from("W0;27ToaUpl_P%'c", 'utf8').copy(iv);

    let b64 = String(enc).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(b64, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(decrypted.toString('utf8'));
    if (parsed && typeof parsed.file === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function buildHlsProxyUrl(targetUrl: string, referer: string): string {
  return `/api/proxy/hls?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(referer)}`;
}

// 6b. Resolve GogoAnime server URL -> Direct ad-free & sandbox-free HLS stream
app.get('/api/anime/stream', async (req: Request, res: Response) => {
  const rawUrl = ((req.query.url as string) || '').trim();
  if (!rawUrl || !isSafeExternalUrl(rawUrl)) {
    return res.status(400).json({ error: 'Valid stream URL required' });
  }

  const cacheKey = `stream_${rawUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    // Case 1: Direct Vidstreaming player.php?m3u8=...
    if (rawUrl.includes('player.php') && rawUrl.includes('m3u8=')) {
      const parsed = new URL(rawUrl);
      const m3u8 = parsed.searchParams.get('m3u8') || '';
      const subtitle = parsed.searchParams.get('subtitle') || '';
      if (m3u8 && isSafeExternalUrl(m3u8)) {
        const ref = `${parsed.origin}/`;
        const tracks = subtitle && isSafeExternalUrl(subtitle)
          ? [{ file: buildHlsProxyUrl(subtitle, ref), label: 'English', kind: 'captions', default: true }]
          : [];
        const result = {
          type: 'hls' as const,
          hlsUrl: buildHlsProxyUrl(m3u8, ref),
          tracks,
        };
        setCached(cacheKey, result, 300);
        return res.json(result);
      }
    }

    // Case 2: Vidmoly (Omega) -> extract direct ad-free m3u8 from embed HTML
    if (rawUrl.includes('vidmoly')) {
      const vmRes = await fetch(rawUrl, {
        headers: { 'User-Agent': ua, Referer: `${GOGO_BASE}/` },
      });
      if (vmRes.ok) {
        const vmHtml = await vmRes.text();
        const m3u8Match = vmHtml.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
        if (m3u8Match && m3u8Match[0] && isSafeExternalUrl(m3u8Match[0])) {
          const ref = `${new URL(rawUrl).origin}/`;
          const posterMatch = vmHtml.match(/image\s*:\s*["'](https?:\/\/[^"']+)["']/i);
          const result = {
            type: 'hls' as const,
            hlsUrl: buildHlsProxyUrl(m3u8Match[0], ref),
            tracks: [],
            poster: posterMatch?.[1] || undefined,
          };
          setCached(cacheKey, result, 300);
          return res.json(result);
        }
      }
      return res.status(502).json({ error: 'Unable to extract HLS stream from Omega mirror' });
    }

    // Case 3: gogoanime.me.uk/newplayer.php -> unwrap MegaPlay & decrypt direct ad-free HLS + VTT subtitles
    if (rawUrl.includes('newplayer.php') || rawUrl.includes('megaplay.buzz')) {
      let playerUrl = rawUrl;
      let playerReferer = `${GOGO_BASE}/`;

      if (rawUrl.includes('newplayer.php')) {
        const npRes = await fetch(rawUrl, {
          headers: { 'User-Agent': ua, Referer: `${GOGO_BASE}/` },
        });
        if (!npRes.ok) {
          return res.status(502).json({ error: 'Upstream player unavailable' });
        }
        const npHtml = await npRes.text();
        const innerMatch = npHtml.match(/<iframe[^>]*src=["']([^"']+)["']/i);
        if (!innerMatch || !innerMatch[1]) {
          return res.status(502).json({ error: 'No video stream found for this episode' });
        }
        playerUrl = innerMatch[1].replace(/&amp;/g, '&');
        playerReferer = `${new URL(rawUrl).origin}/`;
      }

      if (!isSafeExternalUrl(playerUrl)) {
        return res.status(502).json({ error: 'Invalid upstream stream URL' });
      }

      const mpRes = await fetch(playerUrl, {
        headers: { 'User-Agent': ua, Referer: playerReferer },
      });
      const mpHtml = await mpRes.text();
      const dataIdMatch = mpHtml.match(/data-id=["'](\d+)["']/i);
      if (!dataIdMatch || !dataIdMatch[1]) {
        return res.status(502).json({ error: 'Stream source not indexed yet for this server' });
      }

      const hostOrigin = new URL(playerUrl).origin;
      const sourcesRes = await fetch(
        `${hostOrigin}/stream/getSources?id=${encodeURIComponent(dataIdMatch[1])}`,
        {
          headers: {
            'User-Agent': ua,
            Referer: `${hostOrigin}/`,
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      );

      if (!sourcesRes.ok) {
        return res.status(502).json({ error: 'Stream source lookup failed' });
      }

      const data: any = await sourcesRes.json();
      let m3u8Url = '';
      if (data.enc) {
        const decrypted = decryptMegaPlayEnc(data.enc);
        if (decrypted?.file) m3u8Url = decrypted.file;
      } else if (Array.isArray(data.sources) && data.sources[0]?.file) {
        m3u8Url = data.sources[0].file;
      } else if (data.sources?.file) {
        m3u8Url = data.sources.file;
      }

      if (!m3u8Url || !isSafeExternalUrl(m3u8Url)) {
        return res.status(502).json({ error: 'Unable to decrypt video stream' });
      }

      const ref = `${hostOrigin}/`;
      const tracks = Array.isArray(data.tracks)
        ? data.tracks
            .filter(
              (t: any) =>
                t &&
                typeof t.file === 'string' &&
                t.kind !== 'thumbnails' &&
                isSafeExternalUrl(t.file)
            )
            .map((t: any) => ({
              file: buildHlsProxyUrl(t.file, ref),
              label: t.label || 'Subtitle',
              kind: t.kind || 'captions',
              default: Boolean(t.default),
            }))
        : [];

      const result = {
        type: 'hls' as const,
        hlsUrl: buildHlsProxyUrl(m3u8Url, ref),
        tracks,
        intro: data.intro || null,
        outro: data.outro || null,
        poster: typeof data.image === 'string' ? data.image : undefined,
      };
      setCached(cacheKey, result, 180);
      return res.json(result);
    }

    // Fallback for non-sandbox native Moon embed (e.g. bysesayeveum.com)
    const fallback = {
      type: 'iframe' as const,
      iframeUrl: rawUrl,
    };
    setCached(cacheKey, fallback, 300);
    return res.json(fallback);
  } catch (err: any) {
    console.error('Error resolving stream:', err.message);
    return res.status(500).json({ error: 'Failed to resolve video stream' });
  }
});

// 6c. HLS Playlist, MPEG-TS Segment, and VTT Subtitle Proxy (eliminates CORS/Referer blocks & ads)
app.get('/api/proxy/hls', async (req: Request, res: Response) => {
  const targetUrl = ((req.query.url as string) || '').trim();
  const ref = ((req.query.ref as string) || 'https://megaplay.buzz/').trim();

  if (!targetUrl || !isSafeExternalUrl(targetUrl)) {
    return res.status(400).send('Invalid URL');
  }

  let originHeader = 'https://megaplay.buzz';
  try {
    if (isSafeExternalUrl(ref)) {
      originHeader = new URL(ref).origin;
    }
  } catch {
    // keep default
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: `${originHeader}/`,
        Origin: originHeader,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!upstream.ok) {
      return res.status(upstream.status).send('Upstream media fetch failed');
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isPlaylist =
      targetUrl.includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('m3u');

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (isPlaylist) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        const rewritten = text
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
                try {
                  const abs = new URL(uri, targetUrl).toString();
                  return `URI="${buildHlsProxyUrl(abs, originHeader + '/')}"`;
                } catch {
                  return `URI="${uri}"`;
                }
              });
            }
            try {
              const abs = new URL(trimmed, targetUrl).toString();
              return buildHlsProxyUrl(abs, originHeader + '/');
            } catch {
              return line;
            }
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(rewritten);
      }
      return res.send(text);
    }

    // Subtitles (.vtt)
    if (targetUrl.includes('.vtt') || contentType.includes('vtt')) {
      const vttText = await upstream.text();
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(vttText);
    }

    // Binary video segments (.ts / disguised .jpg MPEG-TS / .m4s / keys)
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const outContentType =
      buffer.length > 0 && buffer[0] === 0x47
        ? 'video/mp2t'
        : contentType || 'application/octet-stream';
    res.setHeader('Content-Type', outContentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  } catch (err: any) {
    clearTimeout(timeoutId);
    return res.status(502).send('Media proxy error');
  }
});

// 7. Genre metadata list
app.get('/api/anime/genres', (_req: Request, res: Response) => {
  const genres = [
    { slug: 'action', name: 'Action' },
    { slug: 'adventure', name: 'Adventure' },
    { slug: 'comedy', name: 'Comedy' },
    { slug: 'drama', name: 'Drama' },
    { slug: 'fantasy', name: 'Fantasy' },
    { slug: 'sci-fi', name: 'Sci-Fi' },
    { slug: 'romance', name: 'Romance' },
    { slug: 'mystery', name: 'Mystery' },
    { slug: 'supernatural', name: 'Supernatural' },
    { slug: 'shounen', name: 'Shounen' },
    { slug: 'sports', name: 'Sports' },
    { slug: 'thriller', name: 'Thriller' },
    { slug: 'slice-of-life', name: 'Slice of Life' },
    { slug: 'isekai', name: 'Isekai' },
    { slug: 'psychological', name: 'Psychological' },
    { slug: 'horror', name: 'Horror' },
    { slug: 'magic', name: 'Magic' },
    { slug: 'mecha', name: 'Mecha' },
  ];
  return res.json({ genres });
});

// 8. Image Proxy to prevent hotlinking or referrer blocks
app.get('/api/proxy-image', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).send('URL required');
  }

  try {
    const response = await fetch(imageUrl, {
      headers: {
        'Referer': GOGO_BASE,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    });

    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch image');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const buffer = await response.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err: any) {
    return res.status(500).send('Image proxy error');
  }
});

// Mount Vite middleware in development or serve static in production
async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
