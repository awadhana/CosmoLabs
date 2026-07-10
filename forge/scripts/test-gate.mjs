/**
 * Forge — generated-site test gate (LANE B, private repo).
 *
 * Serves ./build over a local static server, drives it with Playwright
 * (chromium) + axe-core, and enforces the HARD checks that define "passing":
 *   - loads with HTTP 200
 *   - no uncaught console errors / page errors
 *   - every internal link + anchor resolves
 *   - every <img>/<video>/<source> has src; every <img> has alt; every <video>
 *     has a poster
 *   - no horizontal scroll at 375 / 768 / 1440
 *   - no placeholder leakage (lorem ipsum / TODO / {{ )
 *   - axe-core a11y score >= 90
 * ADVISORY (logged, never blocks): a rough performance signal (asset weight +
 * load timing). Perf-rich video sites routinely miss mobile perf; we track it.
 *
 * Output: ./work/test-report.json always. On any HARD failure it also writes
 * ./work/test-failures.json (the fix-loop hook a build-site re-run consumes)
 * and exits non-zero. No PII is involved (the site is brief-derived, not PII).
 */

import http from "node:http";
import path from "node:path";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

import { logStage } from "./lib.mjs";

const BUILD_DIR = path.resolve("build");
const WORK_DIR = path.resolve("work");
const VIEWPORTS = [375, 768, 1440];
const A11Y_MIN = 90;
const AXE_WEIGHTS = { critical: 25, serious: 10, moderate: 3, minor: 1 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function startServer(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.join(root, rel);
      // Path-traversal guard.
      if (!path.resolve(filePath).startsWith(root)) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      let target = filePath;
      if (existsSync(target) && (await stat(target)).isDirectory()) {
        target = path.join(target, "index.html");
      }
      if (!existsSync(target)) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(target).toLowerCase()] || "application/octet-stream");
      res.end(await readFile(target));
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function dirWeightBytes(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirWeightBytes(full);
    else total += (await stat(full)).size;
  }
  return total;
}

/** Resolve an internal href/anchor against the build dir. Returns a failure
 *  detail string, or null when it resolves. */
function checkLinkTarget(href, anchorIds) {
  if (!href) return null;
  if (/^(https?:|mailto:|tel:|data:)/i.test(href)) return null; // external, not our gate
  if (href.startsWith("#")) {
    const id = href.slice(1);
    if (id === "" || id === "top") return null;
    return anchorIds.has(id) ? null : `missing anchor target #${id}`;
  }
  const [rawPath, frag] = href.split("#");
  let rel = rawPath.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const filePath = path.join(BUILD_DIR, rel);
  if (!path.resolve(filePath).startsWith(BUILD_DIR)) return `link escapes build dir: ${href}`;
  if (!existsSync(filePath)) return `broken internal link: ${href}`;
  if (frag && rel === "index.html" && !anchorIds.has(frag)) return `missing anchor target #${frag}`;
  return null;
}

async function runChecks() {
  const { server, port } = await startServer(BUILD_DIR);
  const base = `http://127.0.0.1:${port}/`;
  const failures = [];
  const advisory = {};
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err?.message || err).slice(0, 200)));

    // HARD: loads 200
    const response = await page.goto(base, { waitUntil: "networkidle", timeout: 45000 });
    if (!response || !response.ok()) {
      failures.push({ check: "load", detail: `homepage returned ${response ? response.status() : "no response"}` });
    }

    // HARD: no console errors
    if (consoleErrors.length > 0) {
      failures.push({ check: "console", detail: `console/page errors: ${consoleErrors.slice(0, 5).join(" | ")}` });
    }

    // Gather DOM facts once.
    const dom = await page.evaluate(() => {
      const ids = [];
      document.querySelectorAll("[id]").forEach((el) => ids.push(el.id));
      document.querySelectorAll("[name]").forEach((el) => {
        const n = el.getAttribute("name");
        if (n) ids.push(n);
      });
      const links = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
      const imgs = [...document.querySelectorAll("img")].map((el) => ({
        src: el.getAttribute("src") || "",
        alt: el.getAttribute("alt"),
      }));
      const videos = [...document.querySelectorAll("video")].map((el) => ({
        src: el.getAttribute("src") || "",
        poster: el.getAttribute("poster") || "",
        sources: [...el.querySelectorAll("source")].map((s) => s.getAttribute("src") || ""),
      }));
      const bodyText = (document.body.innerText || "").toLowerCase();
      const html = document.documentElement.outerHTML;
      return { ids, links, imgs, videos, bodyText, html };
    });
    const anchorIds = new Set(dom.ids);

    // HARD: internal links + anchors resolve
    for (const href of dom.links) {
      const detail = checkLinkTarget(href, anchorIds);
      if (detail) failures.push({ check: "links", detail });
    }

    // HARD: media src + alt + poster
    dom.imgs.forEach((img, i) => {
      if (!img.src) failures.push({ check: "media", detail: `img[${i}] missing src` });
      if (img.alt === null || img.alt.trim() === "") failures.push({ check: "media", detail: `img[${i}] missing alt` });
    });
    dom.videos.forEach((v, i) => {
      const hasSrc = v.src || v.sources.some(Boolean);
      if (!hasSrc) failures.push({ check: "media", detail: `video[${i}] missing src/source` });
      if (!v.poster) failures.push({ check: "media", detail: `video[${i}] missing poster` });
    });

    // HARD: no placeholder leakage
    for (const token of ["lorem ipsum", "todo", "{{"]) {
      if (dom.bodyText.includes(token) || dom.html.toLowerCase().includes(token)) {
        failures.push({ check: "placeholder", detail: `placeholder token found: "${token}"` });
      }
    }

    // HARD: no horizontal scroll at each viewport
    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      if (overflow > 1) {
        failures.push({ check: "overflow", detail: `horizontal scroll ${overflow}px at ${width}px` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // HARD: axe-core a11y score >= 90
    const axe = await new AxeBuilder({ page }).analyze();
    let penalty = 0;
    for (const v of axe.violations) {
      const nodes = Math.min(v.nodes?.length || 1, 3);
      penalty += (AXE_WEIGHTS[v.impact] || 1) * nodes;
    }
    const a11yScore = Math.max(0, 100 - penalty);
    if (a11yScore < A11Y_MIN) {
      failures.push({
        check: "a11y",
        detail: `axe score ${a11yScore} < ${A11Y_MIN}; violations: ${axe.violations
          .slice(0, 6)
          .map((v) => `${v.id}(${v.impact})`)
          .join(", ")}`,
      });
    }

    // ADVISORY: rough perf signal — asset weight + load timing.
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return nav ? { loadMs: Math.round(nav.loadEventEnd), domMs: Math.round(nav.domContentLoadedEventEnd) } : {};
    });
    advisory.assetBytes = await dirWeightBytes(BUILD_DIR);
    advisory.loadMs = timing.loadMs ?? null;
    advisory.a11yScore = a11yScore;

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  return { failures, advisory };
}

async function main() {
  await mkdir(WORK_DIR, { recursive: true });
  if (!existsSync(path.join(BUILD_DIR, "index.html"))) {
    const report = { pass: false, failures: [{ check: "build", detail: "build/index.html missing" }] };
    await writeFile(path.join(WORK_DIR, "test-report.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(WORK_DIR, "test-failures.json"), JSON.stringify(report.failures, null, 2));
    logStage("test", "failed", { hard: report.failures.length });
    process.exit(1);
  }

  const { failures, advisory } = await runChecks();
  const pass = failures.length === 0;
  const report = { pass, failures, advisory, checkedAt: new Date().toISOString() };
  await writeFile(path.join(WORK_DIR, "test-report.json"), JSON.stringify(report, null, 2));

  if (!pass) {
    // Fix-loop hook: a build-site re-run reads this file and edits ./build.
    await writeFile(path.join(WORK_DIR, "test-failures.json"), JSON.stringify(failures, null, 2));
    logStage("test", "failed", { hard: failures.length, advisory });
    process.exit(1);
  }

  logStage("test", "ok", { advisory });
}

main().catch((err) => {
  logStage("test", "error", { reason: err?.message || "unknown error" });
  process.exit(1);
});
