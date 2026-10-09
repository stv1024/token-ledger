import type { PluginClientContext } from '@getpaseo/plugin/client';

// Git installs have no node_modules. The host compiler resolves only SDK
// specifiers, so every client type is derived from the host-provided API.
export type PaseoApi = PluginClientContext['paseo'];
export type PaseoAgent = Exclude<Parameters<PaseoApi['agents']['ref']>[0], string>;
