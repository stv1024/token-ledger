import type { PluginClientContext } from '@getpaseo/plugin/client';

// Git installs have no node_modules. The host compiler resolves only SDK
// specifiers, so every client type is derived from the host-provided API.
export type PaseoApi = PluginClientContext['paseo'];
type AgentUpdate = Parameters<Parameters<PaseoApi['agents']['subscribe']>[0]>[0];
// From the update stream: since 0.16 `agents.ref` also accepts an `AgentRef`.
export type PaseoAgent = Extract<AgentUpdate, { kind: 'upsert' }>['agent'];
