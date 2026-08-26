import { getSarvamClient } from '../sarvam/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Extract a structured field value from user speech for the current MML question.
 * @param {{ field: string, question: string, userText: string }} params
 * @returns {Promise<{ ok: boolean, value: string|null, normalized: string|null, confLow: boolean }>}
 */
export async function extractIntakeAnswer({ field, question, userText }) {
  const client = getSarvamClient();

  const system = `आप Make My Lagan (MML) matrimony कॉल के डेटा-extractor हैं।
यूज़र की हिंदी/अंग्रेज़ी बात से केवल माँगा गया फ़ील्ड निकालें।
सिर्फ JSON लौटाएँ, कोई और टेक्स्ट नहीं:
{"ok":true|false,"value":"...","normalized":"...","reason":"..."}

नियम:
- ok=true तभी जब फ़ील्ड स्पष्ट मिले।
- अधूरा/अस्पष्ट हो तो ok=false।
- gender: normalized केवल "male", "female", या "other".
- dateOfBirth: normalized YYYY-MM-DD हो सके तो, वरना value में जैसी बोली गई तिथि।
- name / partnerDetails: साफ़ संक्षिप्त टेक्स्ट।`;

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

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed?.ok) {
      return { ok: false, value: null, normalized: null, confLow: true };
    }

    let value = String(parsed.value || parsed.normalized || '').trim();
    let normalized = parsed.normalized != null ? String(parsed.normalized).trim() : value;

    if (field === 'gender') {
      normalized = normalizeGender(normalized || value);
      value = normalized;
      if (!normalized) return { ok: false, value: null, normalized: null, confLow: true };
    }

    if (!value) return { ok: false, value: null, normalized: null, confLow: true };

    return { ok: true, value, normalized, confLow: false };
  } catch (err) {
    logger.warn({ err, field, userText }, 'LLM extract failed — using heuristic');
    return heuristicExtract(field, userText);
  }
}

function normalizeGender(text) {
  const t = String(text || '').toLowerCase();
  if (/^(male|m|man|boy|पुरुष|लड़का|मर्द|male)$/i.test(t) || t.includes('पुरुष') || t.includes('लड़का')) {
    return 'male';
  }
  if (
    /^(female|f|woman|girl|महिला|स्त्री|लड़की|औरत)$/i.test(t) ||
    t.includes('महिला') ||
    t.includes('लड़की') ||
    t.includes('स्त्री')
  ) {
    return 'female';
  }
  if (t.includes('other') || t.includes('अन्य')) return 'other';
  return null;
}

function heuristicExtract(field, userText) {
  const text = String(userText || '').trim();
  if (!text || text.length < 2) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }

  if (field === 'gender') {
    const g = normalizeGender(text);
    return g
      ? { ok: true, value: g, normalized: g, confLow: false }
      : { ok: false, value: null, normalized: null, confLow: true };
  }

  if (field === 'name') {
    // Reject if it looks like only gender/yes
    if (normalizeGender(text) || /^(हाँ|हां|जी|yes|no)$/i.test(text)) {
      return { ok: false, value: null, normalized: null, confLow: true };
    }
    return { ok: true, value: text, normalized: text, confLow: false };
  }

  if (field === 'dateOfBirth') {
    // Keep spoken form; require some digit or month word
    if (!/\d/.test(text) && !/(जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text)) {
      return { ok: false, value: null, normalized: null, confLow: true };
    }
    return { ok: true, value: text, normalized: text, confLow: false };
  }

  // partnerDetails — accept any reasonably long answer
  if (text.replace(/\s/g, '').length < 4) {
    return { ok: false, value: null, normalized: null, confLow: true };
  }
  return { ok: true, value: text, normalized: text, confLow: false };
}

export default extractIntakeAnswer;
