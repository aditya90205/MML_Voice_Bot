import { getSarvamClient } from '../sarvam/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Extract a structured field value from user speech for the current MML question.
 * @param {{ field: string, question: string, userText: string }} params
 * @returns {Promise<{ ok: boolean, value: string|null, normalized: string|null, confLow: boolean }>}
 */
export async function extractIntakeAnswer({ field, question, userText }) {
  // Gender: prefer fast local mapping (handles STT "mail" → male, etc.)
  // Accept any real answer so pronunciation / STT quirks don't loop the question.
  if (field === 'gender') {
    return extractGender(userText);
  }

  const client = getSarvamClient();

  const system = `You are a data extractor for Make My Lagan (MML) matrimony intake calls.
From the user's English (or Hindi) speech, extract ONLY the requested field.
Return JSON only, no other text:
{"ok":true|false,"value":"...","normalized":"...","reason":"..."}

Rules:
- ok=true only when the field is clearly present.
- If incomplete or unclear, ok=false.
- dateOfBirth: prefer normalized YYYY-MM-DD when possible; otherwise keep the spoken date in value.
- name / partnerDetails: clean, concise text.`;

  const user = `Field: ${field}
Question asked: ${question}
User said: ${userText}`;

  try {
    const response = await client.chat.completions({
      model: env.SARVAM_CHAT_MODEL,
      temperature: 0.1,
      max_tokens: 256,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const message = response?.choices?.[0]?.message || {};
    let raw =
      (typeof message.content === 'string' && message.content.trim()) ||
      (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) ||
      '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return heuristicExtract(field, userText);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return heuristicExtract(field, userText);
    }

    if (!parsed?.ok) {
      return heuristicExtract(field, userText);
    }

    let value = String(parsed.value || parsed.normalized || '').trim();
    let normalized = parsed.normalized != null ? String(parsed.normalized).trim() : value;

    if (!value) return heuristicExtract(field, userText);

    return { ok: true, value, normalized, confLow: false };
  } catch (err) {
    logger.warn({ err, field, userText }, 'LLM extract failed — using heuristic');
    return heuristicExtract(field, userText);
  }
}

/**
 * Map spoken / STT gender answers → male | female | other.
 * Common STT mistakes: "mail" for male, "femail" for female, etc.
 */
function normalizeGender(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return null;

  // Female first (so "female" is never treated as male)
  if (
    /\b(female|femail|females?|woman|women|girl|lady|ladies|mahila|स्त्री|लड़की|औरत|महिला)\b/.test(t) ||
    t === 'f' ||
    t.includes('महिला') ||
    t.includes('लड़की')
  ) {
    return 'female';
  }

  // Male — include STT mishearings like "mail"
  if (
    /\b(male|mail|males?|man|men|boy|guys?|gentleman|purush|पुरुष|लड़का|मर्द)\b/.test(t) ||
    t === 'm' ||
    t.includes('पुरुष') ||
    t.includes('लड़का')
  ) {
    return 'male';
  }

  if (/\b(other|others|non.?binary|prefer not|अन्य)\b/.test(t)) {
    return 'other';
  }

  return null;
}

/**
 * Gender: always accept a real spoken answer.
 * Prefer male/female/other when we can map it; otherwise store what they said.
 */
function extractGender(userText) {
  const text = String(userText || '').trim();
  if (!text || text.replace(/\s/g, '').length < 1) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }

  // Ignore pure fillers that aren't an answer
  if (/^(um+|uh+|hmm+|ah+|okay|ok|yes|yeah|yep|no|nope|जी|हाँ|हां)$/i.test(text.trim())) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }

  const mapped = normalizeGender(text);
  if (mapped) {
    logger.info({ userText: text, mapped }, 'Gender mapped from speech');
    return { ok: true, value: mapped, normalized: mapped, confLow: false };
  }

  // Any other non-empty answer — store as-is so we don't re-ask forever
  logger.info({ userText: text }, 'Gender stored as spoken text (no strict map)');
  return { ok: true, value: text, normalized: text, confLow: true };
}

function heuristicExtract(field, userText) {
  const text = String(userText || '').trim();
  if (!text || text.length < 2) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }

  if (field === 'gender') {
    return extractGender(text);
  }

  if (field === 'name') {
    if (normalizeGender(text) || /^(हाँ|हां|जी|yes|no|okay|ok)$/i.test(text)) {
      return { ok: false, value: null, normalized: null, confLow: true };
    }
    return { ok: true, value: text, normalized: text, confLow: false };
  }

  if (field === 'dateOfBirth') {
    if (
      !/\d/.test(text) &&
      !/(जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(
        text
      )
    ) {
      return { ok: false, value: null, normalized: null, confLow: true };
    }
    return { ok: true, value: text, normalized: text, confLow: false };
  }

  if (text.replace(/\s/g, '').length < 4) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }
  return { ok: true, value: text, normalized: text, confLow: false };
}

export default extractIntakeAnswer;
