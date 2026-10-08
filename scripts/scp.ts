import { readFileSync } from 'node:fs';

// The logic of scripts/apply-scps.ts. It holds no AWS call of its own: a function `aws` runs one AWS CLI call,
// so the tests can replace it. The script uses only the `organizations` API.
//
// Safety rules in this file:
// - A target is the name of a lab account. A raw account ID, a root, an organisational unit and the management account
//   are all refused.
// - The script touches only the policies in POLICIES. Their names start with `lab-`.
// - The script never prints an account ID.

export const LAB_TARGETS = ['dev', 'test', 'staging', 'production'] as const;
export type LabTarget = (typeof LAB_TARGETS)[number];

// An SCP can hold 5120 characters.
export const SCP_SIZE_LIMIT = 5120;

export interface PolicySpec {
  name: string;
  file: string;
  description: string;
  // The accounts where the policy may be attached.
  targets: readonly LabTarget[];
}

export const POLICIES: readonly PolicySpec[] = [
  {
    name: 'lab-dev-guardrail',
    file: 'scp/lab-dev-guardrail.json',
    description: 'Lab: dev account may use eu-west-2 only, and no expensive service (lab-platform#43)',
    targets: ['dev'],
  },
  {
    name: 'lab-pipeline-role-guard',
    file: 'scp/lab-pipeline-role-guard.json',
    description: 'Lab: only the SSO administrator may change github-platform-deploy or remove the GitHub OIDC provider (lab-platform#43)',
    targets: LAB_TARGETS,
  },
];

export function policySpec(name: string): PolicySpec {
  const spec = POLICIES.find((policy) => policy.name === name);
  if (!spec) throw new Error(`unknown policy "${name}". Known: ${POLICIES.map((p) => p.name).join(', ')}`);
  return spec;
}

// ---- The env file with the account IDs (outside the repository) ----

export type Accounts = Record<LabTarget | 'management', string>;

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1] as string] = (match[2] as string).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

const ENV_KEYS: Record<LabTarget | 'management', string> = {
  management: 'MGMT_ACCOUNT_ID',
  dev: 'DEV_ACCOUNT_ID',
  test: 'TEST_ACCOUNT_ID',
  staging: 'STAGING_ACCOUNT_ID',
  production: 'PROD_ACCOUNT_ID',
};

export function labAccounts(env: Record<string, string>): Accounts {
  const accounts = {} as Accounts;
  for (const [name, key] of Object.entries(ENV_KEYS) as [keyof Accounts, string][]) {
    const value = env[key];
    if (value === undefined) throw new Error(`${key} is missing in the env file`);
    if (!/^\d{12}$/.test(value)) throw new Error(`${key} is not a 12-digit account ID`);
    accounts[name] = value;
  }
  for (const name of LAB_TARGETS) {
    if (accounts[name] === accounts.management) throw new Error(`${ENV_KEYS[name]} is the management account`);
  }
  const ids = LAB_TARGETS.map((name) => accounts[name]);
  if (new Set(ids).size !== ids.length) throw new Error('two lab names have the same account');
  return accounts;
}

// ---- The target check ----

export interface Target {
  name: LabTarget;
  accountId: string;
}

export function resolveTargets(accounts: Accounts, spec: PolicySpec, names: readonly string[]): Target[] {
  if (names.length === 0) throw new Error('give at least one target: ' + LAB_TARGETS.join(', '));
  return names.map((name) => {
    if (!(LAB_TARGETS as readonly string[]).includes(name)) {
      throw new Error(`"${name}" is not a lab account. Use one of: ${LAB_TARGETS.join(', ')}`);
    }
    const target = name as LabTarget;
    if (!spec.targets.includes(target)) {
      throw new Error(`${spec.name} is only for: ${spec.targets.join(', ')}`);
    }
    return { name: target, accountId: accounts[target] };
  });
}

// ---- The policy document ----

// Returns the document without white space. This is the form that the script sends and that AWS counts.
export function compactPolicy(text: string): string {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`the policy is not valid JSON: ${(error as Error).message}`);
  }
  const statements = (document as { Statement?: unknown } | null)?.Statement;
  if (!Array.isArray(statements) || statements.length === 0) throw new Error('the policy has no Statement');
  const compact = JSON.stringify(document);
  if (compact.length > SCP_SIZE_LIMIT) throw new Error(`the policy has ${compact.length} characters, the limit is ${SCP_SIZE_LIMIT}`);
  if (/\d{12}/.test(compact)) throw new Error('the policy holds a 12-digit number, maybe an account ID. Use a wildcard');
  return compact;
}

// JSON with sorted keys, to compare two documents.
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export function loadPolicy(spec: PolicySpec, root: URL): string {
  if (!spec.name.startsWith('lab-')) throw new Error('refusing a policy whose name does not start with lab-');
  return compactPolicy(readFileSync(new URL(spec.file, root), 'utf8'));
}

// ---- The organisation calls ----

export type Aws = (args: string[]) => string;
export type Log = (message: string) => void;

interface Context {
  aws: Aws;
  log: Log;
  accounts: Accounts;
  spec: PolicySpec;
  targets: readonly Target[];
  dryRun?: boolean;
}

const json = <T>(aws: Aws, args: string[]): T => JSON.parse(aws(['organizations', ...args])) as T;

// Stops unless the profile is the management account of the organisation named in the env file.
function checkOrganisation({ aws, accounts }: Context): void {
  const { Organization } = json<{ Organization: { MasterAccountId: string } }>(aws, ['describe-organization']);
  if (Organization.MasterAccountId !== accounts.management) {
    throw new Error('the profile is not in the management account of the organisation in the env file');
  }
  const { Roots } = json<{ Roots: { Id: string; PolicyTypes?: { Type: string; Status: string }[] }[] }>(aws, ['list-roots']);
  const enabled = Roots.some((root) => root.PolicyTypes?.some((t) => t.Type === 'SERVICE_CONTROL_POLICY' && t.Status === 'ENABLED'));
  if (!enabled) {
    throw new Error('service control policies are not enabled. Run once: aws organizations enable-policy-type --root-id <root id> --policy-type SERVICE_CONTROL_POLICY');
  }
}

function findPolicy({ aws, spec }: Context): string | undefined {
  const { Policies } = json<{ Policies: { Id: string; Name: string; AwsManaged?: boolean }[] }>(aws, ['list-policies', '--filter', 'SERVICE_CONTROL_POLICY']);
  const found = Policies.find((policy) => policy.Name === spec.name);
  if (found?.AwsManaged) throw new Error(`${spec.name} is managed by AWS. The script does not touch it`);
  return found?.Id;
}

function isAttached({ aws }: Context, policyId: string, target: Target): boolean {
  const { Policies } = json<{ Policies: { Id: string }[] }>(aws, [
    'list-policies-for-target', '--target-id', target.accountId, '--filter', 'SERVICE_CONTROL_POLICY',
  ]);
  return Policies.some((policy) => policy.Id === policyId);
}

export function applyPolicy(context: Context & { content: string }): void {
  const { aws, log, spec, targets, content, dryRun } = context;
  checkOrganisation(context);
  let policyId = findPolicy(context);

  if (policyId === undefined) {
    log(`create policy ${spec.name}`);
    if (!dryRun) {
      const created = json<{ Policy: { PolicySummary: { Id: string } } }>(aws, [
        'create-policy', '--name', spec.name, '--description', spec.description, '--type', 'SERVICE_CONTROL_POLICY', '--content', content,
      ]);
      policyId = created.Policy.PolicySummary.Id;
    }
  } else {
    const current = json<{ Policy: { Content: string } }>(aws, ['describe-policy', '--policy-id', policyId]);
    if (canonical(JSON.parse(current.Policy.Content)) === canonical(JSON.parse(content))) {
      log(`policy ${spec.name} (${policyId}) is up to date`);
    } else {
      log(`update policy ${spec.name} (${policyId})`);
      if (!dryRun) aws(['organizations', 'update-policy', '--policy-id', policyId, '--content', content]);
    }
  }

  for (const target of targets) {
    if (policyId !== undefined && isAttached(context, policyId, target)) {
      log(`${spec.name} is already attached to ${target.name}`);
      continue;
    }
    log(`attach ${spec.name} to ${target.name}`);
    if (!dryRun && policyId !== undefined) aws(['organizations', 'attach-policy', '--policy-id', policyId, '--target-id', target.accountId]);
  }
}

export function removePolicy(context: Context & { deletePolicy?: boolean }): void {
  const { aws, log, spec, targets, deletePolicy, dryRun } = context;
  checkOrganisation(context);
  const policyId = findPolicy(context);
  if (policyId === undefined) {
    log(`policy ${spec.name} does not exist`);
    return;
  }
  for (const target of targets) {
    if (!isAttached(context, policyId, target)) {
      log(`${spec.name} is not attached to ${target.name}`);
      continue;
    }
    log(`detach ${spec.name} from ${target.name}`);
    if (!dryRun) aws(['organizations', 'detach-policy', '--policy-id', policyId, '--target-id', target.accountId]);
  }
  if (deletePolicy) {
    const { Targets } = json<{ Targets: unknown[] }>(aws, ['list-targets-for-policy', '--policy-id', policyId]);
    if (Targets.length > 0 && !dryRun) {
      log(`keep ${spec.name}: it is still attached to ${Targets.length} target(s)`);
    } else {
      log(`delete policy ${spec.name}`);
      if (!dryRun) aws(['organizations', 'delete-policy', '--policy-id', policyId]);
    }
  }
}

export function statusOf(context: Omit<Context, 'targets'>, targets: readonly Target[]): string[] {
  checkOrganisation({ ...context, targets });
  const lines: string[] = [];
  const policyId = findPolicy({ ...context, targets });
  lines.push(`${context.spec.name}: ${policyId === undefined ? 'not created' : policyId}`);
  for (const target of targets) {
    const attached = policyId !== undefined && isAttached({ ...context, targets }, policyId, target);
    lines.push(`  ${target.name}: ${attached ? 'attached' : 'not attached'}`);
  }
  return lines;
}
