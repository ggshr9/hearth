// MockAgentAdapter — wraps the deterministic mock ingest as an AgentAdapter.
// Used as the default --agent for tests and for running hearth without an API key.

import { mockIngest } from './mock.ts';
import type { AgentAdapter, IngestInput, VaultContext } from '../core/agent-adapter.ts';
import type { ChangePlan } from '../core/types.ts';

export class MockAgentAdapter implements AgentAdapter {
  readonly name = 'mock';

  async planIngest(input: IngestInput, _ctx: VaultContext): Promise<ChangePlan> {
    const { plan } = mockIngest(input.sourcePath, { vaultRoot: _ctx.vaultRoot });
    return plan;
  }
}
