/**
 * POST /api/clarify — ask Claude (via the official @anthropic-ai/sdk) whether
 * a project brief has enough information for an autonomous build team, and if
 * not, which clarifying questions to ask (max 4).
 *
 * Contract: on ANY failure — missing ANTHROPIC_API_KEY, API error, timeout,
 * malformed model output — return HTTP 200 with the static fallback questions
 * and source:"fallback". Method / content-type / origin / rate-limit
 * violations keep their usual status codes.
 */

import Anthropic from "@anthropic-ai/sdk";

import { checkRateLimit } from "./_lib/ratelimit.js";
import {
  checkSameOrigin,
  getClientIp,
  isValidHexColor,
  isValidHttpUrl,
  rejectOversizedBody,
  requireJsonContentType,
  requireMethod,
  sanitizeText,
  sendJson,
} from "./_lib/security.js";

const MODEL = "claude-opus-4-8";

const FALLBACK_QUESTIONS = [
  {
    id: "q1",
    question:
      "Who is the primary audience or user of this project, and what is the single most important thing they should be able to do?",
  },
  {
    id: "q2",
    question:
      "Do you have existing branding, content, or accounts (domain, logins, copy, images) we should build with, or are we starting from scratch?",
  },
  {
    id: "q3",
    question: "What is your ideal timeline and budget range for this project?",
  },
];

const SYSTEM_PROMPT = `You are a senior intake analyst at CosmoLabs, a consulting firm that builds software, websites, and apps for clients. You are given a client's project brief. Decide whether an autonomous AI build team has enough information to start building.

If information is missing, ask up to 4 concise, non-redundant clarifying questions that cover the biggest gaps, prioritizing: audience/purpose, must-have features, content/branding readiness, integrations, and timeline/budget. Never ask about something the brief already answers, and never ask two questions that overlap.

If the brief already covers those areas well enough to start, respond with ready: true and an empty questions array.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ready: { type: "boolean" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
        },
        required: ["id", "question"],
        additionalProperties: false,
      },
    },
  },
  required: ["ready", "questions"],
  additionalProperties: false,
};

function sendFallback(res) {
  sendJson(res, 200, { ok: true, ready: false, questions: FALLBACK_QUESTIONS, source: "fallback" });
}

/** Defensive truncation — never trust client-supplied lengths. */
function buildBrief(body) {
  const title = sanitizeText(body.title, 200) || "(not provided)";
  const description = sanitizeText(body.description, 5000) || "(not provided)";

  const lines = [`Title: ${title}`, "", `Description:`, description];

  if (Array.isArray(body.references)) {
    const refs = body.references
      .slice(0, 5)
      .map((r) => {
        if (!r || typeof r !== "object") return null;
        const url = sanitizeText(r.url, 500);
        if (!url || !isValidHttpUrl(url, 500)) return null;
        const note = sanitizeText(r.note, 300);
        return note ? `- ${url} — ${note}` : `- ${url}`;
      })
      .filter(Boolean);
    if (refs.length) lines.push("", "Reference sites:", ...refs);
  }

  const cs = body.colorScheme;
  if (cs && typeof cs === "object" && !Array.isArray(cs)) {
    const parts = [];
    if (["light", "dark", "either"].includes(cs.mode)) parts.push(`mode: ${cs.mode}`);
    if (Array.isArray(cs.colors)) {
      const colors = cs.colors.slice(0, 6).filter(isValidHexColor);
      if (colors.length) parts.push(`colors: ${colors.join(", ")}`);
    }
    const notes = sanitizeText(cs.notes, 500);
    if (notes) parts.push(`notes: ${notes}`);
    if (parts.length) lines.push("", `Color scheme: ${parts.join("; ")}`);
  }

  return lines.join("\n");
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;
  if (!requireJsonContentType(req, res)) return;
  if (!rejectOversizedBody(req, res)) return;
  if (!checkSameOrigin(req, res)) return;

  const ip = getClientIp(req);
  const rate = checkRateLimit(ip, "clarify", 6, 10 * 60 * 1000);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    sendJson(res, 429, { ok: false, error: "Too many requests. Please wait a few minutes and try again." });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");

    if (!process.env.ANTHROPIC_API_KEY) {
      sendFallback(res);
      return;
    }

    // 10s timeout (ms in the JS SDK); no retries so we stay within the
    // serverless request budget. Sampling params (temperature/top_p) are
    // intentionally absent — they are rejected on this model.
    const client = new Anthropic({ timeout: 10_000, maxRetries: 0 });

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: RESPONSE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Here is the client's project brief:\n\n${buildBrief(body)}`,
        },
      ],
    });

    // With output_config.format the first text block contains valid JSON.
    const text = message.content.find((block) => block.type === "text")?.text ?? "";
    const parsed = JSON.parse(text);

    const ready = parsed.ready === true;
    let questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    questions = questions
      .slice(0, 4)
      .map((q, i) => ({
        id: typeof q?.id === "string" && q.id.trim() ? sanitizeText(q.id, 32) : `q${i + 1}`,
        question: sanitizeText(q?.question, 500) || "",
      }))
      .filter((q) => q.question.length > 0);

    if (ready) {
      // Model says the brief is complete — trust it and return no questions,
      // even if it also emitted some (ready:true + questions is contradictory).
      sendJson(res, 200, { ok: true, ready: true, questions: [], source: "ai" });
    } else if (questions.length === 0) {
      // Not ready but nothing usable to ask (every question sanitized to
      // empty) — never send {ready:false, questions:[]}; use the fallback set.
      sendFallback(res);
    } else {
      sendJson(res, 200, { ok: true, ready: false, questions, source: "ai" });
    }
  } catch (err) {
    // Never leak internals; the fallback keeps the intake flow moving.
    console.error("[clarify] falling back:", err?.message || err);
    sendFallback(res);
  }
}
