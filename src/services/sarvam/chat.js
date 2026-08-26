import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getSarvamClient } from './client.js';

/**
 * Generate an assistant reply from conversation history.
 * @param {{ messages: Array<{role: string, content: string}>, systemPrompt?: string }} params
 */
export async function generateChatReply({ messages, systemPrompt }) {
  const client = getSarvamClient();
  const payload = {
    model: env.SARVAM_CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt || env.AI_SYSTEM_PROMPT,
      },
      ...messages,
    ],
    temperature: 0.3,
    max_tokens: 512,
    // Keep reasoning light so the model still returns spoken content for voice.
    reasoning_effort: 'low',
  };

  logger.info({ model: payload.model, turns: messages.length }, 'Sarvam chat request');

  const response = await client.chat.completions(payload);
  const message = response?.choices?.[0]?.message || response?.choices?.message || {};

  let text =
    (typeof message.content === 'string' && message.content.trim()) ||
    (typeof message.reasoning_content === 'string' &&
      extractFinalAnswer(message.reasoning_content)) ||
    null;

  if (!text) {
    logger.error({ response }, 'Unexpected Sarvam chat response shape');
    throw new Error('Empty chat response from Sarvam');
  }

  // Voice replies should stay short.
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 400) {
    text = `${text.slice(0, 397)}...`;
  }

  return text;
}

/**
 * If the model only returned reasoning, try to salvage a short final line.
 */
function extractFinalAnswer(reasoning) {
  const lines = String(reasoning)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer a quoted final answer if present.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/"([^"]{3,200})"/);
    if (m) return m[1];
  }

  const last = lines[lines.length - 1];
  if (last && last.length < 220 && !last.endsWith(':')) {
    return last.replace(/^\*+\s*/, '').replace(/^[-•]\s*/, '');
  }

  return null;
}

export default generateChatReply;
