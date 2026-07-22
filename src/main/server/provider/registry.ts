/**
 * ProviderRegistry — the built-in set of provider handlers and the routing that
 * resolves one per turn.
 *
 * The engine holds one registry, constructs each handler once (sharing the
 * single `AgentHost`), and
 * asks it for the adapter that owns a given model/provider. Adding a vendor =
 * implement `ProviderAdapter` and register it here.
 *
 * @module provider/registry
 */
import { providerForModel } from '../models'
import { ClaudeAdapter } from './claudeAdapter'
import { CodexAdapter } from './codexAdapter'
import { CodexAppServerAdapter } from './codexAppServerAdapter'
import type { AgentHost, ProviderAdapter, ProviderKind } from './types'

export class ProviderRegistry {
  private readonly adapters: Record<ProviderKind, ProviderAdapter>

  constructor(host: AgentHost) {
    this.adapters = {
      claude: new ClaudeAdapter(host),
      codex: new CodexAdapter(host),
      codexAgent: new CodexAppServerAdapter(host)
    }
  }

  /** Resolve the handler for a provider kind. */
  get(kind: ProviderKind): ProviderAdapter {
    return this.adapters[kind]
  }

  /** Resolve the handler for a thread's selected model (null = Claude default). */
  forModel(model: string | null): ProviderAdapter {
    return this.adapters[providerForModel(model)]
  }

  /** Every registered handler — used for broadcast operations like title cancel. */
  all(): ProviderAdapter[] {
    return Object.values(this.adapters)
  }
}
