// MCP stdio province: exposes one tool `files_query({question}) -> {hits}` over
// the wire contract hearth's federated-client expects. stdout is the MCP
// transport — ALL logging goes to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildIndex, type IndexRecord } from './index-store.ts';
import { search } from './search.ts';

export function parseArgs(argv: string[]): { roots: string[]; toolName: string } {
  const roots: string[] = [];
  let toolName = 'files_query';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) roots.push(argv[++i]!);
    else if (argv[i] === '--name' && argv[i + 1] !== undefined) toolName = argv[++i]!;
  }
  return { roots, toolName };
}

export function createFilesServer(index: IndexRecord[], toolName: string): Server {
  const server = new Server({ name: 'source-files', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: toolName,
      description: 'Keyword search over local files (txt/md + Office/PDF). Returns snippet hits with file:line anchors.',
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== toolName) {
      return { content: [{ type: 'text', text: JSON.stringify({ hits: [] }) }], isError: true };
    }
    const question = String((req.params.arguments ?? {}).question ?? '');
    const hits = search(index, question);
    return { content: [{ type: 'text', text: JSON.stringify({ hits }) }] };
  });
  return server;
}

export async function main(argv: string[]): Promise<void> {
  const { roots, toolName } = parseArgs(argv);
  process.stderr.write(`[source-files] indexing ${roots.length} root(s): ${roots.join(', ') || '(none)'}\n`);
  const index = await buildIndex(roots);
  process.stderr.write(`[source-files] indexed ${index.length} file(s); tool=${toolName}\n`);
  const server = createFilesServer(index, toolName);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
