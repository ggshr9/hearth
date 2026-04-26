// hearth setup — interactive one-command onboarding.
//
// Goal: zero → working in under 2 minutes for a user who has an existing
// Obsidian vault. Wraps adopt + doctor + Claude Code MCP config in a
// single guided flow with sensible auto-detection and preview-then-confirm
// for every write.
//
// Idempotent: re-running on an already-set-up vault is a no-op (will detect
// adopted state and skip steps already done).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildProposal, applyProposal, renderProposalSummary } from './adopt.ts';
import { runDoctor, renderDoctorReport } from './doctor.ts';

interface SetupContext {
  vaultRoot: string;
  hearthRepoRoot: string;
}

/** Find candidate Obsidian vault paths. Heuristics, not exhaustive. */
function detectObsidianVaults(): string[] {
  const candidates = new Set<string>();
  const home = homedir();

  // 1. Read Obsidian's own list of recently-opened vaults
  const obsidianConfigPath = (() => {
    if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    if (platform() === 'win32') return join(home, 'AppData', 'Roaming', 'obsidian', 'obsidian.json');
    return join(home, '.config', 'obsidian', 'obsidian.json');
  })();
  if (existsSync(obsidianConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(obsidianConfigPath, 'utf8')) as { vaults?: Record<string, { path: string }> };
      if (cfg.vaults) {
        for (const v of Object.values(cfg.vaults)) {
          if (v.path && existsSync(v.path)) candidates.add(v.path);
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Walk common roots looking for .obsidian/ markers (shallow, fast)
  const roots = [
    join(home, 'Documents'),
    join(home, 'vault'),
    join(home, 'Vault'),
    join(home, 'Notes'),
    join(home, 'Obsidian'),
    home,
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const full = join(root, name);
      try {
        if (statSync(full).isDirectory() && existsSync(join(full, '.obsidian'))) {
          candidates.add(full);
        }
      } catch { /* skip */ }
    }
    // One level deeper for ~/Documents (catches things like ~/Documents/vault/myvault)
    if (root === join(home, 'Documents')) {
      for (const name of entries) {
        const sub = join(root, name);
        let subEntries: string[];
        try {
          if (!statSync(sub).isDirectory()) continue;
          subEntries = readdirSync(sub);
        } catch { continue; }
        for (const inner of subEntries) {
          const innerFull = join(sub, inner);
          try {
            if (statSync(innerFull).isDirectory() && existsSync(join(innerFull, '.obsidian'))) {
              candidates.add(innerFull);
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  return [...candidates].sort();
}

/** Determine the Claude Code MCP config path for the current OS. */
function claudeCodeMcpConfigPath(): string {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform() === 'win32') return join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'claude-code', 'mcp.json');
}

/**
 * Compose the hearth MCP server entry. Read existing config, merge non-
 * destructively, return the new JSON. Does NOT write. Caller decides.
 */
function composeMcpConfig(existingPath: string, ctx: SetupContext): { existing: unknown; next: Record<string, unknown> } {
  let existing: Record<string, unknown> = {};
  if (existsSync(existingPath)) {
    try { existing = JSON.parse(readFileSync(existingPath, 'utf8')) as Record<string, unknown>; }
    catch { /* malformed; treat as empty, but we'll warn the user */ }
  }
  // Some clients use "servers", others "mcpServers"; honor whichever exists.
  const key = ('mcpServers' in existing) ? 'mcpServers' : 'servers';
  const servers = (existing[key] as Record<string, unknown> | undefined) ?? {};
  const next: Record<string, unknown> = { ...existing, [key]: { ...servers, hearth: {
    command: 'bun',
    args: [join(ctx.hearthRepoRoot, 'src', 'cli', 'index.ts'), 'mcp', 'serve'],
    env: { HEARTH_VAULT: ctx.vaultRoot },
  } } };
  return { existing, next };
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]: ` : ': ';
  const a = await rl.question(prompt + suffix);
  return (a.trim() || defaultValue || '').trim();
}

async function askYN(rl: ReturnType<typeof createInterface>, prompt: string, def: 'y' | 'n' = 'n'): Promise<boolean> {
  const a = (await rl.question(`${prompt} [${def === 'y' ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
  if (!a) return def === 'y';
  return a === 'y' || a === 'yes';
}

export async function runSetup(opts: { hearthRepoRoot: string }): Promise<number> {
  const rl = createInterface({ input, output });
  try {
    process.stdout.write('\n');
    process.stdout.write('  hearth setup\n');
    process.stdout.write('  ────────────\n');
    process.stdout.write('  zero → working, one command. you can re-run any time.\n\n');

    // ── 1. Pick vault ─────────────────────────────────────────────────────
    process.stdout.write('  · scanning for Obsidian vaults …\n');
    const candidates = detectObsidianVaults();
    let vault: string;
    if (candidates.length === 0) {
      process.stdout.write('    none auto-detected.\n');
      vault = await ask(rl, '  vault path');
      if (!vault) { process.stderr.write('  no vault. aborting.\n'); return 1; }
      vault = resolve(vault);
    } else {
      process.stdout.write('    found:\n');
      candidates.forEach((c, i) => process.stdout.write(`      [${i + 1}] ${c}\n`));
      process.stdout.write(`      [${candidates.length + 1}] enter a different path\n`);
      const choice = (await ask(rl, '  choose', '1')).trim();
      const idx = parseInt(choice, 10);
      if (idx >= 1 && idx <= candidates.length) {
        vault = candidates[idx - 1]!;
      } else if (idx === candidates.length + 1) {
        const custom = await ask(rl, '  vault path');
        if (!custom) { process.stderr.write('  no vault. aborting.\n'); return 1; }
        vault = resolve(custom);
      } else {
        process.stderr.write('  invalid choice. aborting.\n'); return 1;
      }
    }

    if (!existsSync(vault)) {
      process.stderr.write(`  vault not found: ${vault}\n`); return 1;
    }
    process.stdout.write(`  ✓ vault: ${vault}\n\n`);

    // ── 2. Adopt (with preview) ───────────────────────────────────────────
    process.stdout.write('  · running adopt preview …\n\n');
    const proposal = buildProposal(vault);
    process.stdout.write(renderProposalSummary(proposal).split('\n').map(l => '    ' + l).join('\n'));
    process.stdout.write('\n');

    if (proposal.blockToAppend === '' && !proposal.willCreateHearthInbox) {
      process.stdout.write('  ✓ vault already adopted. nothing to write.\n\n');
    } else {
      const ok = await askYN(rl, '  apply this adopt? (only writes SCHEMA.md tail + creates the inbox dir)', 'y');
      if (!ok) { process.stdout.write('  setup cancelled at adopt step.\n'); return 0; }
      const r = applyProposal(proposal);
      if (r.appendedToSchema) process.stdout.write(`  ✓ appended canonical block to ${r.schemaPath}\n`);
      if (r.createdInbox) process.stdout.write(`  ✓ created ${r.inboxPath}\n`);
      for (const w of r.warnings) process.stdout.write(`  ⚠ ${w}\n`);
    }

    // ── 3. Doctor ────────────────────────────────────────────────────────
    process.stdout.write('\n  · running doctor …\n\n');
    const dr = runDoctor(vault);
    process.stdout.write(renderDoctorReport(dr).split('\n').map(l => '    ' + l).join('\n'));
    process.stdout.write('\n');
    if (!dr.ok) { process.stderr.write('\n  doctor failed; fix the issues above and re-run.\n'); return 1; }

    // ── 4. Optional: Claude Code MCP wiring ──────────────────────────────
    const wantClaude = await askYN(rl, '  wire hearth into Claude Code via MCP? (writes mcp config — preview first)', 'y');
    if (wantClaude) {
      const ccPath = claudeCodeMcpConfigPath();
      const { existing, next } = composeMcpConfig(ccPath, { vaultRoot: vault, hearthRepoRoot: opts.hearthRepoRoot });
      const exists = existsSync(ccPath);
      process.stdout.write(`\n  · target: ${ccPath} (${exists ? 'exists' : 'will create'})\n`);
      if (exists && Object.keys(existing).length === 0) {
        process.stdout.write('    ⚠ existing file is empty/unparseable; would replace.\n');
      }
      const oldHearth = (existing as { servers?: { hearth?: unknown }; mcpServers?: { hearth?: unknown } }).servers?.hearth ?? (existing as { mcpServers?: { hearth?: unknown } }).mcpServers?.hearth;
      if (oldHearth) process.stdout.write('    note: a hearth entry already exists — will be replaced.\n');
      process.stdout.write('\n    proposed addition:\n');
      const proposedJson = JSON.stringify({ hearth: ('mcpServers' in next ? (next as { mcpServers: Record<string, unknown> }).mcpServers : (next as { servers: Record<string, unknown> }).servers).hearth }, null, 2);
      process.stdout.write(proposedJson.split('\n').map(l => '      ' + l).join('\n'));
      process.stdout.write('\n');
      const okWrite = await askYN(rl, '  write this config?', 'y');
      if (okWrite) {
        mkdirSync(dirname(ccPath), { recursive: true });
        writeFileSync(ccPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
        process.stdout.write(`  ✓ wrote ${ccPath}\n`);
        process.stdout.write('  · restart Claude Code to pick up the new MCP server.\n');
      } else {
        process.stdout.write('  Claude Code config skipped. you can wire later via docs/INTEGRATIONS.md.\n');
      }
    }

    // ── 5. Done ──────────────────────────────────────────────────────────
    process.stdout.write('\n  setup complete.\n\n');
    process.stdout.write('  next:\n');
    process.stdout.write(`    1. (if Claude Code wired) restart Claude Code, then ask it:\n`);
    process.stdout.write(`         "read hearth://agent-instructions then hearth://schema"\n`);
    process.stdout.write(`    2. capture from CLI:\n`);
    process.stdout.write(`         hearth channel ingest --channel cli --message-id m1 --from you \\\n`);
    process.stdout.write(`           --text "your first thought" --vault ${vault}\n`);
    process.stdout.write(`    3. inspect what hearth has done:\n`);
    process.stdout.write(`         hearth log --vault ${vault} --since 1d\n`);
    process.stdout.write('\n');
    return 0;
  } finally {
    rl.close();
  }
}
