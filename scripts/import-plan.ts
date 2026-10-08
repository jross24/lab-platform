// The decisions of the import step. This file has no AWS call, so unit tests cover it.
// scripts/import-missing.ts uses it. See the README, section "Take over a setting that exists already".

// The mapping file holds this text where the account ID goes. The file is public, so it must not hold the ID.
export const ACCOUNT_ID_PLACEHOLDER = '{{account-id}}';

// One entry for each resource: its logical ID, and the properties that identify the real resource.
export type ResourceMapping = Record<string, Record<string, string>>;

export type Decision = {
  // nothing: the stack holds every resource already.
  // create:  the stack does not exist yet. The normal deployment creates the stack and the resources.
  // import:  the stack exists and lacks some resources. Import them before the normal deployment.
  action: 'nothing' | 'create' | 'import';
  toImport: string[];
};

export function decide(state: { stackExists: boolean; missing: readonly string[] }): Decision {
  if (!state.stackExists) return { action: 'create', toImport: [] };
  if (state.missing.length === 0) return { action: 'nothing', toImport: [] };
  return { action: 'import', toImport: [...state.missing] };
}

// The resources of the mapping that the stack does not list.
export function missingResources(mappedIds: readonly string[], listedIds: readonly string[]): string[] {
  const listed = new Set(listedIds);
  return mappedIds.filter((id) => !listed.has(id));
}

// The logical IDs in the JSON answer of `aws cloudformation list-stack-resources`.
export function listedLogicalIds(answer: string): string[] {
  const parsed = JSON.parse(answer) as { StackResourceSummaries?: { LogicalResourceId: string }[] };
  return (parsed.StackResourceSummaries ?? []).map((summary) => summary.LogicalResourceId);
}

// Reads the mapping file text and puts the account ID in. Any other placeholder is an error.
export function fillMapping(text: string, accountId: string): ResourceMapping {
  if (!/^[0-9]{12}$/.test(accountId)) throw new Error('The account ID must have 12 digits.');
  const filled = text.replaceAll(ACCOUNT_ID_PLACEHOLDER, accountId);
  const other = filled.match(/{{[^}]*}}/);
  if (other) throw new Error(`The mapping file has a placeholder that this script does not know: ${other[0]}`);
  return JSON.parse(filled) as ResourceMapping;
}

// CDK asks for an identifier of every resource that it imports, so the mapping must cover all of them.
export function restrictMapping(mapping: ResourceMapping, ids: readonly string[]): ResourceMapping {
  const restricted: ResourceMapping = {};
  for (const id of ids) {
    const entry = mapping[id];
    if (!entry) throw new Error(`The mapping file has no entry for ${id}.`);
    restricted[id] = entry;
  }
  return restricted;
}
