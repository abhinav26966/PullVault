import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'production') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  config({ path: path.resolve(here, '../../../.env.local') });
}
