import { SarvamAIClient } from 'sarvamai';
import { env } from '../../config/env.js';

let client;

export function getSarvamClient() {
  if (!client) {
    client = new SarvamAIClient({
      apiSubscriptionKey: env.SARVAM_API_KEY,
    });
  }
  return client;
}

export default getSarvamClient;
