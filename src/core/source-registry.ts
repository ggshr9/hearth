// Federated source registry — Phase 2a (HF1).
//
// Reads <stateDir>/sources.json: a JSON array describing external MCP
// sources hearth's query() may federate a question out to. This module is
// deliberately fail-safe: any problem with the file (missing, malformed,
// individual bad entries) degrades to "no federated sources" rather than
// throwing. A broken sources.json must never break vault-only query, which
// is the property the rest of hearth depends on.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FederatedSource {
  id: string;
  description?: string;
  transport: {
    kind: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  query_tool: string;
}

function defaultStateDir(): string {
  return join(homedir(), '.hearth');
}

function isValidSource(entry: unknown): entry is FederatedSource {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.query_tool !== 'string' || e.query_tool.length === 0) return false;

  const transport = e.transport;
  if (typeof transport !== 'object' || transport === null) return false;
  const t = transport as Record<string, unknown>;
  if (t.kind !== 'stdio') return false;
  if (typeof t.command !== 'string' || t.command.length === 0) return false;

  return true;
}

/**
 * Load federated source definitions from <stateDir ?? ~/.hearth>/sources.json.
 * Never throws: a missing file, malformed JSON, a non-array top level, or
 * individual invalid entries all degrade to an empty (or partially filtered)
 * result rather than raising.
 */
export function loadSources(stateDir?: string): FederatedSource[] {
  const dir = stateDir ?? defaultStateDir();
  const path = join(dir, 'sources.json');

  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.warn(`[hearth] source-registry: failed to read ${path}:`, err);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[hearth] source-registry: malformed JSON in ${path}:`, err);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[hearth] source-registry: ${path} did not contain a JSON array; ignoring`);
    return [];
  }

  const sources: FederatedSource[] = [];
  for (const entry of parsed) {
    if (isValidSource(entry)) {
      sources.push(entry);
    } else {
      console.warn(`[hearth] source-registry: dropping invalid entry in ${path}:`, entry);
    }
  }
  return sources;
}
