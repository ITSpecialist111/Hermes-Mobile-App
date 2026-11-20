export const VERSION: string;
export interface Capability {
  readonly id: string;
  readonly kind: 'tool' | 'service' | 'specialist';
  readonly connection: string;
  readonly description: string;
}
export interface Pack { readonly id: string; readonly capabilities: readonly Capability[] }
export interface Manifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly packIds: readonly string[];
  readonly missions: Readonly<Record<string, readonly string[]>>;
}
export interface Context { readonly tenantId: string; readonly scopeId: string; readonly workflowId: string }
export interface Role { readonly id: string; readonly purpose: string }
export interface Invocation extends Context { readonly capabilityId: string; readonly role?: Role }
export interface Output { summary: string; sources: readonly string[] }
export type Execute = (input: Invocation) => Output | Promise<Output>;
export interface Binding {
  capabilityIds: readonly string[];
  execute: Execute;
  openSpecialist?(input: Invocation & {role: Role}): {execute: Execute; close(): void | Promise<void>} | Promise<{execute: Execute; close(): void | Promise<void>}>;
}
export interface Result {
  coreId: string;
  workflowId: string;
  runtimeVersion: string;
  findings: Array<Output & { capabilityId: string }>;
  events: Array<{ kind: string; capabilityId: string }>;
}
export function validateDefinition(manifest: unknown, packs: unknown): void;
export function createCatalogue(manifest: Manifest, packs: readonly Pack[]): {
  resolve(missionId: string, requested?: readonly string[]): Capability[];
};
export function createCore(options: {
  manifest: Manifest; packs: readonly Pack[]; bindings: Readonly<Record<string, Binding>>; tenantId: string; scopeId: string;
}): {
  run(missionId: string, context: Context, proposedCapabilities?: readonly string[]): Promise<Result>;
  discover(missionId: string): Capability[];
};
