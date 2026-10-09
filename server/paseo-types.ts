import type { PluginHandlerContext } from '@getpaseo/plugin/server';

// Git installs have no node_modules. The host compiler resolves only SDK
// specifiers, so every client type is derived from the host-provided API.
export type PaseoApi = PluginHandlerContext['paseo'];
type Agents = PaseoApi['agents'];
type Workspaces = PaseoApi['workspaces'];
type Timeline = ReturnType<Agents['ref']>['timeline'];

export type PaseoAgent = Exclude<Parameters<Agents['ref']>[0], string>;
export type PaseoAgentTimelineEvent = Parameters<Parameters<Timeline['subscribe']>[0]>[0];
export type PaseoAgentTimelineSubscription = ReturnType<Timeline['subscribe']>;
export type PaseoWorkspace = Exclude<Parameters<Workspaces['ref']>[0], string>;
export type PaseoWorkspaceListResult = Awaited<ReturnType<Workspaces['list']>>;
export type PaseoWorkspaceUpdate = Parameters<Parameters<Workspaces['subscribe']>[0]>[0];
