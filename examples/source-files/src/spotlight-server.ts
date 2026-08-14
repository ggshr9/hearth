// MCP stdio server, Spotlight mode: files_query({question}) over macOS
// Spotlight (mdfind) for whole-disk recall + extract/search for precise hits.
// stdout is the MCP transport — all logging to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mdfind, hitsFromPaths, filterCandidates, DOC_EXTS } from './spotlight.ts';

export function parseSpotlightArgs(argv: string[]): { onlyIn: string[]; toolName: string; limit: number; exclude: string[]; allowExts: string[] | null } {
  const onlyIn: string[] = [];
  const exclude: string[] = [];
  let toolName = 'files_query';
  let limit = 40;
  let allowExts: string[] | null = DOC_EXTS as string[];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--onlyin' && argv[i + 1] !== undefined) onlyIn.push(argv[++i]!);
    else if (argv[i] === '--name' && argv[i + 1] !== undefined) toolName = argv[++i]!;
    else if (argv[i] === '--exclude' && argv[i + 1] !== undefined) exclude.push(argv[++i]!);
    else if (argv[i] === '--ext' && argv[i + 1] !== undefined) allowExts = argv[++i]!.split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--all-types') allowExts = null;
    else if (argv[i] === '--limit' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { onlyIn, toolName, limit, exclude, allowExts };
}

export interface SpotlightDeps { mdfind: typeof mdfind; hitsFromPaths: typeof hitsFromPaths }

export function createSpotlightServer(
  toolName: string,
  opts: { onlyIn: string[]; limit: number; exclude: string[]; allowExts: string[] | null },
  deps: SpotlightDeps = { mdfind, hitsFromPaths },
): Server {
  const server = new Server({ name: 'source-files-spotlight', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: toolName,
      description: 'Whole-disk file search via macOS Spotlight (mdfind). Returns snippet hits with file:line anchors.',
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== toolName) {
      return { content: [{ type: 'text', text: JSON.stringify({ hits: [] }) }], isError: true };
    }
    const question = String((req.params.arguments ?? {}).question ?? '');
    const pool = Math.max(opts.limit * 6, 200);
    const raw = await deps.mdfind(question, { onlyIn: opts.onlyIn, limit: pool });
    const candidates = filterCandidates(raw, { exclude: opts.exclude, allowExts: opts.allowExts }).slice(0, opts.limit);
    const hits = await deps.hitsFromPaths(candidates, question);
    return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] };
  });
  return server;
}

export async function main(argv: string[]): Promise<void> {
  const { onlyIn, toolName, limit, exclude, allowExts } = parseSpotlightArgs(argv);
  const mode = allowExts === null ? 'all-types' : `docs(${allowExts.length} exts)`;
  process.stderr.write(`[source-files] spotlight mode: scope=${onlyIn.length ? onlyIn.join(',') : 'whole-disk'} limit=${limit} filter=${mode} tool=${toolName}\n`);
  const server = createSpotlightServer(toolName, { onlyIn, limit, exclude, allowExts });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
