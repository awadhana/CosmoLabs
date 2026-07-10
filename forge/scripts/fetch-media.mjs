/**
 * Forge — stock media fetcher (LANE B, private repo).
 *
 * Runs in JOB "build" with ONLY PEXELS_API_KEY. Reads ./work/brief.json, derives
 * 2-4 search queries, and pulls SELF-HOSTED media into ./build/assets/:
 *   - ONE landscape hero VIDEO (~1080p mp4) + its poster frame image
 *   - 3-6 supporting photos
 * Writes ./build/assets/manifest.json describing every asset with Pexels
 * attribution (required by the Pexels license).
 *
 * Pexels forbids nothing here except hotlinking on our side — the generated-site
 * CSP is media-src 'self', so everything is downloaded. On 429 / no results /
 * missing key, we fall back to a built-in gradient poster set and log it; the
 * build never crashes for want of stock media.
 *
 * No PII is read or logged — brief.json is already PII-stripped.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { logStage } from "./lib.mjs";

const ASSETS_DIR = path.resolve("build", "assets");
const PEXELS_VIDEO = "https://api.pexels.com/videos/search";
const PEXELS_PHOTO = "https://api.pexels.com/v1/search";
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "your", "our", "you", "are",
  "will", "from", "have", "want", "need", "like", "make", "into", "site",
  "website", "page", "landing", "brand", "company", "business", "please",
  "would", "should", "about", "using", "very", "more", "them", "they",
]);

const HEX_RE = /#[0-9a-fA-F]{6}/g;
const DEFAULT_COLORS = ["#1b1035", "#3a1d6e", "#7b5cff"];

async function pexels(url, key) {
  const res = await fetch(url, { headers: { Authorization: key } });
  if (res.status === 429) throw new Error("pexels rate limited (429)");
  if (!res.ok) throw new Error(`pexels error ${res.status}`);
  return res.json();
}

function deriveQueries(brief) {
  const text = `${brief.title || ""} ${brief.description || ""}`.toLowerCase();
  const words = text.match(/[a-z]{4,}/g) || [];
  const freq = new Map();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 3);

  const queries = [];
  if (brief.title) queries.push(String(brief.title).slice(0, 60));
  if (top.length >= 2) queries.push(`${top[0]} ${top[1]}`);
  for (const w of top) queries.push(w);
  const cs = typeof brief.colorScheme === "string" ? brief.colorScheme : "";
  if (cs) queries.push(`${cs} background`);
  queries.push("abstract technology background");

  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
}

function pickVideoFile(video) {
  const files = Array.isArray(video.video_files) ? video.video_files : [];
  const mp4 = files.filter((f) => (f.file_type || "").includes("mp4") && f.link);
  if (mp4.length === 0) return null;
  // Prefer a landscape file nearest 1080p height, width >= 1280.
  const scored = mp4
    .map((f) => ({
      f,
      score:
        Math.abs((f.height || 0) - 1080) +
        ((f.width || 0) >= 1280 ? 0 : 1000) +
        (f.quality === "hd" ? 0 : 200),
    }))
    .sort((a, b) => a.score - b.score);
  return scored[0].f;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function gradientSvg(colors, label) {
  const [a, b, c] = colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" role="img" aria-label="${label}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${a}"/><stop offset="55%" stop-color="${b}"/><stop offset="100%" stop-color="${c}"/>
  </linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
</svg>`;
}

async function writeFallback(brief, reason) {
  await mkdir(ASSETS_DIR, { recursive: true });
  const colors = ((JSON.stringify(brief.colorScheme || "")).match(HEX_RE) || DEFAULT_COLORS).slice(0, 3);
  const palette = colors.length === 3 ? colors : DEFAULT_COLORS;
  const assets = [];
  const poster = "hero-poster.svg";
  await writeFile(path.join(ASSETS_DIR, poster), gradientSvg(palette, "Abstract gradient background"));
  assets.push({ path: `assets/${poster}`, type: "poster", role: "hero-poster", alt: "Abstract gradient background", credit: null });
  for (let i = 1; i <= 3; i++) {
    const name = `bg-${i}.svg`;
    const rotated = [palette[(i) % 3], palette[(i + 1) % 3], palette[(i + 2) % 3]];
    await writeFile(path.join(ASSETS_DIR, name), gradientSvg(rotated, "Abstract gradient panel"));
    assets.push({ path: `assets/${name}`, type: "image", role: "gallery", alt: "Abstract gradient panel", credit: null });
  }
  const manifest = { hero: { video: null, poster: `assets/${poster}` }, assets, fallback: true, reason };
  await writeFile(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  logStage("media", "fallback", { reason, assets: assets.length });
}

async function main() {
  const key = process.env.PEXELS_API_KEY;
  const briefRaw = await readFile(path.resolve("work", "brief.json"), "utf8");
  const brief = JSON.parse(briefRaw);
  const started = Date.now();

  if (!key) {
    await writeFallback(brief, "PEXELS_API_KEY not configured");
    return;
  }

  try {
    await mkdir(ASSETS_DIR, { recursive: true });
    const queries = deriveQueries(brief);
    const assets = [];
    let hero = { video: null, poster: null };

    // Hero video: first usable landscape result across the queries.
    for (const q of queries) {
      const url = `${PEXELS_VIDEO}?query=${encodeURIComponent(q)}&per_page=8&orientation=landscape&size=medium`;
      const data = await pexels(url, key);
      const videos = Array.isArray(data.videos) ? data.videos : [];
      for (const v of videos) {
        const file = pickVideoFile(v);
        if (!file) continue;
        await download(file.link, path.join(ASSETS_DIR, "hero-video.mp4"));
        if (v.image) await download(v.image, path.join(ASSETS_DIR, "hero-poster.jpg"));
        hero = {
          video: "assets/hero-video.mp4",
          poster: v.image ? "assets/hero-poster.jpg" : null,
        };
        assets.push({
          path: "assets/hero-video.mp4",
          type: "video",
          role: "hero",
          alt: `${brief.title || "Hero"} background motion`,
          credit: { source: "Pexels", author: v.user?.name || "Pexels", url: v.url || "https://www.pexels.com" },
        });
        break;
      }
      if (hero.video) break;
    }

    // Supporting photos: gather 3-6 across the queries.
    const wantPhotos = 6;
    const seen = new Set();
    for (const q of queries) {
      if (assets.filter((a) => a.role === "gallery").length >= wantPhotos) break;
      const url = `${PEXELS_PHOTO}?query=${encodeURIComponent(q)}&per_page=6&orientation=landscape`;
      const data = await pexels(url, key);
      const photos = Array.isArray(data.photos) ? data.photos : [];
      for (const p of photos) {
        if (seen.has(p.id) || assets.filter((a) => a.role === "gallery").length >= wantPhotos) continue;
        seen.add(p.id);
        const idx = assets.filter((a) => a.role === "gallery").length + 1;
        const name = `photo-${idx}.jpg`;
        const srcUrl = p.src?.large2x || p.src?.large || p.src?.original;
        if (!srcUrl) continue;
        await download(srcUrl, path.join(ASSETS_DIR, name));
        assets.push({
          path: `assets/${name}`,
          type: "image",
          role: "gallery",
          alt: p.alt || `${brief.title || "Supporting"} imagery`,
          credit: { source: "Pexels", author: p.photographer || "Pexels", url: p.url || "https://www.pexels.com" },
        });
      }
    }

    const galleryCount = assets.filter((a) => a.role === "gallery").length;
    if (!hero.poster && galleryCount === 0) {
      // Nothing usable came back — treat as no-results.
      await writeFallback(brief, "no usable Pexels results");
      return;
    }
    if (!hero.poster && galleryCount > 0) {
      hero.poster = assets.find((a) => a.role === "gallery")?.path || null;
    }

    const manifest = { hero, assets, fallback: false };
    await writeFile(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
    logStage("media", "ok", {
      video: Boolean(hero.video),
      photos: galleryCount,
      queries: queries.length,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    // Any Pexels failure (429/network/parse) -> fallback, never crash.
    await writeFallback(brief, err?.message || "pexels failure");
  }
}

main().catch((err) => {
  logStage("media", "error", { reason: err?.message || "unknown error" });
  process.exit(1);
});
