import { randomUUID } from 'node:crypto';

export function createId(prefix = '') {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
