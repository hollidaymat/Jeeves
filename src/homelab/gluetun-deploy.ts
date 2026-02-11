/**
 * Gluetun stack deploy — copy template to /opt/stacks and run docker compose.
 * Uses main env at /opt/stacks/.env (no stack-specific .env).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deployStack } from './docker/compose-manager.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'stacks', 'gluetun-qbittorrent');
const STACK_DIR = '/opt/stacks/gluetun-qbittorrent';

const FILES_TO_COPY = ['docker-compose.yml', 'README.md'];

export interface GluetunDeployResult {
  success: boolean;
  message: string;
  copied: string[];
  skipped: string[];
  deployed: boolean;
}

export async function deployGluetunStack(): Promise<GluetunDeployResult> {
  const result: GluetunDeployResult = { success: false, message: '', copied: [], skipped: [], deployed: false };

  if (!existsSync(TEMPLATE_DIR)) {
    result.message = `Template not found: ${TEMPLATE_DIR}`;
    return result;
  }

  try {
    if (!existsSync(STACK_DIR)) {
      mkdirSync(STACK_DIR, { recursive: true });
      logger.info('[gluetun-deploy] Created ' + STACK_DIR);
    }

    for (const file of FILES_TO_COPY) {
      const src = join(TEMPLATE_DIR, file);
      const dest = join(STACK_DIR, file);
      if (!existsSync(src)) {
        result.skipped.push(file);
        continue;
      }
      const content = readFileSync(src, 'utf8');
      writeFileSync(dest, content, 'utf8');
      result.copied.push(file);
    }

    const mainEnv = join(REPO_ROOT, '.env');
    if (!existsSync(mainEnv)) {
      result.message =
        `Stack files copied. Create ${mainEnv} and add your VPN_* variables (see .env.example in templates/stacks/gluetun-qbittorrent/). Then say "deploy gluetun" again.`;
      result.success = true;
      return result;
    }

    const deploy = await deployStack('gluetun-qbittorrent');
    result.deployed = deploy.success;
    result.success = deploy.success;
    result.message = deploy.success
      ? `Gluetun stack deployed. ${(deploy.output || '').trim()}`
      : (deploy.error || deploy.output || 'Deploy failed.');
    return result;
  } catch (err) {
    logger.error('[gluetun-deploy]', { error: err instanceof Error ? err.message : String(err) });
    result.message = String(err);
    return result;
  }
}
