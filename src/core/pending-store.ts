// Pending ChangePlan store. Lives in ~/.hearth/pending/<change_id>.yaml
// (or a per-vault override). Plans are YAML so a human can review by hand.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';
import type { ChangePlan } from './types.ts';

export function defaultPendingDir(): string {
  return join(homedir(), '.hearth', 'pending');
}

export class PendingStore {
  constructor(public readonly dir: string = defaultPendingDir()) {
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(changeId: string): string {
    return join(this.dir, `${changeId}.yaml`);
  }

  save(plan: ChangePlan): string {
    const p = this.pathFor(plan.change_id);
    writeFileSync(p, stringify(plan, { lineWidth: 0 }), { mode: 0o600 });
    return p;
  }

  load(changeId: string): ChangePlan {
    const p = this.pathFor(changeId);
    if (!existsSync(p)) {
      throw new Error(`pending plan not found: ${changeId} (looked in ${p})`);
    }
    return parse(readFileSync(p, 'utf8')) as ChangePlan;
  }

  list(): ChangePlan[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter(f => f.endsWith('.yaml'));
    return files.map(f => parse(readFileSync(join(this.dir, f), 'utf8')) as ChangePlan)
                .sort((a, b) => a.created_at < b.created_at ? -1 : 1);
  }

  remove(changeId: string): void {
    const p = this.pathFor(changeId);
    if (existsSync(p)) unlinkSync(p);
  }
}
