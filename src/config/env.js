import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('*'),
  API_KEY: z.string().min(8, 'API_KEY must be at least 8 characters'),

  SOCKET_PING_INTERVAL_MS: z.coerce.number().int().positive().default(25000),
  SOCKET_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  CALL_RING_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  CALL_MAX_DURATION_MS: z.coerce.number().int().positive().default(600000),
  CALL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),

  SARVAM_API_KEY: z.string().min(1, 'SARVAM_API_KEY is required'),
  SARVAM_STT_MODEL: z.string().default('saaras:v3'),
  SARVAM_STT_MODE: z
    .enum(['transcribe', 'translate', 'verbatim', 'translit', 'codemix'])
    .default('transcribe'),
  SARVAM_STT_LANGUAGE: z.string().default('hi-IN'),
  SARVAM_STT_SAMPLE_RATE: z.coerce.number().int().positive().default(16000),
  SARVAM_CHAT_MODEL: z.string().default('sarvam-105b'),
  SARVAM_TTS_MODEL: z.string().default('bulbul:v3'),
  SARVAM_TTS_SPEAKER: z.string().default('priya'),
  SARVAM_TTS_LANGUAGE: z.string().default('hi-IN'),
  SARVAM_TTS_CODEC: z.string().default('mp3'),
  /** Speeding factor for bulbul:v3 (0.5–2.0). 1.0 = normal; ~1.15 = a bit faster. */
  SARVAM_TTS_PACE: z.coerce.number().min(0.5).max(2.0).default(1.15),

  AI_SYSTEM_PROMPT: z
    .string()
    .default(
      'आप Make My Lagan (MML) की matrimony intake एजेंट हैं। केवल निर्धारित सवाल पूछकर नाम, लिंग, जन्म तिथि और पार्टनर की ज़रूरतें इकट्ठा करें। हिंदी में संक्षिप्त और विनम्र रहें।'
    ),
  AI_GREETING_TEXT: z
    .string()
    .default(
      'नमस्ते! मैं Make My Lagan, यानी MML की ओर से बात कर रही हूँ। हम आपकी शादी संबंधी ज़रूरतें समझना चाहते हैं। कुछ छोटे सवाल पूछूँगी, कृपया एक-एक करके जवाब दीजिए।'
    ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error('Invalid environment configuration:\n' + details);
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  isProd: data.NODE_ENV === 'production',
  isDev: data.NODE_ENV === 'development',
  corsOrigins:
    data.CORS_ORIGINS.trim() === '*'
      ? '*'
      : data.CORS_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
};

export default env;
