import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LAB_TARGETS,
  POLICIES,
  SCP_SIZE_LIMIT,
  applyPolicy,
  canonical,
  compactPolicy,
  labAccounts,
  parseEnv,
  policySpec,
  removePolicy,
  resolveTargets,
  type Aws,
} from '../scripts/scp.ts';

// Fake account IDs. The real ones live in a file outside the repository.
const ENV_TEXT = `
# comment
LAB_REGION=eu-west-2
MGMT_ACCOUNT_ID=999999999999
TEST_ACCOUNT_ID=111111111111
STAGING_ACCOUNT_ID=222222222222
PROD_ACCOUNT_ID=333333333333
DEV_ACCOUNT_ID=444444444444
SSO_START_URL=https://example.awsapps.com/start
`;
const ACCOUNTS = labAccounts(parseEnv(ENV_TEXT));

function readPolicy(file: string) {
  return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
}

// IAM matches a pattern with * in it against a string. A `*` matches any characters, also a slash.
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').split('*').join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

describe('parseEnv and labAccounts', () => {
  it('reads the four lab accounts and the management account', () => {
    expect(ACCOUNTS).toEqual({
      dev: '444444444444',
      test: '111111111111',
      staging: '222222222222',
      production: '333333333333',
      management: '999999999999',
    });
  });

  it('refuses a missing account', () => {
    expect(() => labAccounts(parseEnv('MGMT_ACCOUNT_ID=999999999999\nDEV_ACCOUNT_ID=444444444444'))).toThrow(/TEST_ACCOUNT_ID/);
  });

  it('refuses a value that is not a 12-digit account ID', () => {
    const bad = ENV_TEXT.replace('444444444444', 'ou-abcd-12345678');
    expect(() => labAccounts(parseEnv(bad))).toThrow(/DEV_ACCOUNT_ID/);
  });

  it('refuses a lab account that is the management account', () => {
    const bad = ENV_TEXT.replace('DEV_ACCOUNT_ID=444444444444', 'DEV_ACCOUNT_ID=999999999999');
    expect(() => labAccounts(parseEnv(bad))).toThrow(/management/);
  });

  it('refuses two lab names with the same account', () => {
    const bad = ENV_TEXT.replace('DEV_ACCOUNT_ID=444444444444', 'DEV_ACCOUNT_ID=111111111111');
    expect(() => labAccounts(parseEnv(bad))).toThrow(/same account/);
  });
});

describe('target check', () => {
  const roleGuard = policySpec('lab-pipeline-role-guard');
  const guardrail = policySpec('lab-dev-guardrail');

  it('names exactly the four lab accounts', () => {
    expect([...LAB_TARGETS].sort()).toEqual(['dev', 'production', 'staging', 'test']);
  });

  it('turns lab target names into account IDs', () => {
    expect(resolveTargets(ACCOUNTS, roleGuard, ['dev', 'test'])).toEqual([
      { name: 'dev', accountId: '444444444444' },
      { name: 'test', accountId: '111111111111' },
    ]);
  });

  it.each([
    'management',
    'mgmt',
    'root',
    'all',
    '',
    'Dev',
    'portal',
    'Cascade',
    '999999999999',
    '444444444444',
    'r-ab12',
    'ou-ab12-12345678',
  ])('refuses the target %j', (target) => {
    expect(() => resolveTargets(ACCOUNTS, roleGuard, [target])).toThrow(/not a lab account/);
  });

  it('refuses a call with no target', () => {
    expect(() => resolveTargets(ACCOUNTS, roleGuard, [])).toThrow(/at least one target/);
  });

  it('keeps the dev guardrail on dev only', () => {
    expect(resolveTargets(ACCOUNTS, guardrail, ['dev'])).toHaveLength(1);
    for (const target of ['test', 'staging', 'production']) {
      expect(() => resolveTargets(ACCOUNTS, guardrail, [target])).toThrow(/only for/);
    }
  });

  it('refuses an unknown policy name', () => {
    expect(() => policySpec('FullAWSAccess')).toThrow(/unknown policy/);
    expect(() => policySpec('lab-other')).toThrow(/unknown policy/);
  });
});

describe('the policy files', () => {
  it('name only policies that start with lab-', () => {
    expect(POLICIES.map((p) => p.name)).toEqual(['lab-dev-guardrail', 'lab-pipeline-role-guard']);
    for (const spec of POLICIES) expect(spec.name.startsWith('lab-')).toBe(true);
  });

  it.each(POLICIES.map((p) => [p.name, p.file]))('%s is valid JSON in the limit of an SCP', (_name, file) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const compact = compactPolicy(text);
    expect(compact.length).toBeLessThanOrEqual(SCP_SIZE_LIMIT);
    expect(JSON.parse(compact).Version).toBe('2012-10-17');
  });

  it.each(POLICIES.map((p) => [p.name, p.file]))('%s holds no account ID and only deny statements', (_name, file) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/\d{12}/);
    for (const statement of JSON.parse(text).Statement) {
      expect(statement.Effect).toBe('Deny');
      expect(statement.Sid).toBeTruthy();
    }
  });

  it('compactPolicy refuses text that is not JSON', () => {
    expect(() => compactPolicy('{ not json')).toThrow(/JSON/);
  });

  it('compactPolicy refuses a document with no statement', () => {
    expect(() => compactPolicy('{"Version":"2012-10-17"}')).toThrow(/Statement/);
  });

  it('compactPolicy refuses a document that is over the limit', () => {
    const big = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['x:' + 'a'.repeat(SCP_SIZE_LIMIT)], Resource: '*' }] };
    expect(() => compactPolicy(JSON.stringify(big))).toThrow(/5120/);
  });

  it('compactPolicy refuses an account ID in the text', () => {
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'x:*', Resource: 'arn:aws:iam::123456789012:role/x' }] };
    expect(() => compactPolicy(JSON.stringify(doc))).toThrow(/account ID/);
  });
});

describe('lab-dev-guardrail', () => {
  const doc = readPolicy('scp/lab-dev-guardrail.json');
  const region = doc.Statement.find((s: { Sid: string }) => s.Sid === 'DenyOtherRegions');
  const services = doc.Statement.find((s: { Sid: string }) => s.Sid === 'DenyExpensiveServices');

  it('denies every region except eu-west-2', () => {
    expect(region.Condition).toEqual({ StringNotEquals: { 'aws:RequestedRegion': ['eu-west-2'] } });
    expect(region.Action).toBeUndefined();
  });

  it('exempts the global services', () => {
    for (const action of ['iam:*', 'sts:*', 'cloudfront:*', 'route53:*', 'budgets:*', 'support:*', 'organizations:*', 'ce:*', 'health:*', 'sso:*']) {
      expect(region.NotAction).toContain(action);
    }
  });

  it('exempts no service that the lab runs in eu-west-2', () => {
    // These services must stay under the region rule, so that the rule limits them.
    for (const service of ['lambda', 'apigateway', 'dynamodb', 'logs', 'ssm', 'xray', 'codedeploy', 'appconfig', 'cloudformation', 'sns']) {
      expect(region.NotAction.some((a: string) => a.startsWith(`${service}:`))).toBe(false);
    }
  });

  it('denies the expensive services', () => {
    for (const action of ['ec2:RunInstances', 'ec2:CreateNatGateway', 'rds:*', 'redshift:*', 'sagemaker:*', 'eks:*', 'elasticache:*', 'es:*']) {
      expect(services.Action).toContain(action);
    }
  });

  it('denies nothing that a lab stack needs', () => {
    // The services of the resource types in the Dev stages: see the README of lab-platform, "The guardrails of the dev account".
    const used = ['apigateway', 'appconfig', 'cloudformation', 'cloudwatch', 'codedeploy', 'dynamodb', 'iam', 'lambda', 'logs', 's3', 'ssm', 'sts', 'xray', 'sns', 'budgets', 'tag', 'sso'];
    for (const action of services.Action as string[]) {
      expect(used).not.toContain(action.split(':')[0]);
    }
    // The only EC2 actions in the list are the ones that start a cost. A Lambda function outside a VPC needs none of them.
    for (const action of (services.Action as string[]).filter((a) => a.startsWith('ec2:'))) {
      expect(action).toMatch(/^ec2:(RunInstances|RequestSpotInstances|CreateFleet|CreateNatGateway|AllocateAddress)$/);
    }
  });
});

describe('lab-pipeline-role-guard', () => {
  const doc = readPolicy('scp/lab-pipeline-role-guard.json');
  const role = doc.Statement.find((s: { Sid: string }) => s.Sid === 'ProtectPipelineRole');
  const provider = doc.Statement.find((s: { Sid: string }) => s.Sid === 'KeepGitHubOidcProvider');
  const exemptions: string[] = role.Condition.ArnNotLike['aws:PrincipalArn'];

  it('guards the role github-platform-deploy and nothing else', () => {
    expect(role.Resource).toBe('arn:aws:iam::*:role/github-platform-deploy');
  });

  it('denies every write verb of IAM on the role', () => {
    const covered = (action: string) => (role.Action as string[]).some((pattern) => globMatch(pattern, action));
    for (const action of [
      'iam:DeleteRole',
      'iam:DeleteRolePolicy',
      'iam:DeleteRolePermissionsBoundary',
      'iam:UpdateRole',
      'iam:UpdateRoleDescription',
      'iam:UpdateAssumeRolePolicy',
      'iam:AttachRolePolicy',
      'iam:DetachRolePolicy',
      'iam:PutRolePolicy',
      'iam:PutRolePermissionsBoundary',
      'iam:TagRole',
      'iam:UntagRole',
    ]) {
      expect(covered(action), action).toBe(true);
    }
  });

  it('does not deny a read of the role', () => {
    for (const action of ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:ListRoleTags']) {
      expect((role.Action as string[]).some((pattern) => globMatch(pattern, action)), action).toBe(false);
    }
  });

  it('exempts the single sign-on administrator, with or without a region in the path', () => {
    const exempt = (arn: string) => exemptions.some((pattern) => globMatch(pattern, arn));
    expect(exempt('arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/eu-west-2/AWSReservedSSO_AdministratorAccess_12bfe92df433a080')).toBe(true);
    expect(exempt('arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_12bfe92df433a080')).toBe(true);
  });

  it('exempts no other principal', () => {
    const exempt = (arn: string) => exemptions.some((pattern) => globMatch(pattern, arn));
    for (const arn of [
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-cfn-exec-role-111111111111-eu-west-2',
      'arn:aws:iam::111111111111:role/cdk-hnb659fds-deploy-role-111111111111-eu-west-2',
      'arn:aws:iam::111111111111:role/github-platform-deploy',
      'arn:aws:iam::111111111111:role/github-deploy',
      'arn:aws:iam::111111111111:role/OrganizationAccountAccessRole',
      'arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/eu-west-2/AWSReservedSSO_ReadOnlyAccess_12bfe92df433a080',
      'arn:aws:iam::111111111111:role/AWSReservedSSO_AdministratorAccess_12bfe92df433a080',
      'arn:aws:iam::111111111111:role/elsewhere/AWSReservedSSO_AdministratorAccess_12bfe92df433a080',
      'arn:aws:iam::111111111111:user/someone',
    ]) {
      expect(exempt(arn), arn).toBe(false);
    }
  });

  it('keeps the OIDC provider of GitHub from removal and from losing its audience', () => {
    expect(provider.Resource).toBe('arn:aws:iam::*:oidc-provider/token.actions.githubusercontent.com');
    expect(provider.Action).toEqual(['iam:DeleteOpenIDConnectProvider', 'iam:RemoveClientIDFromOpenIDConnectProvider']);
    expect(provider.Condition.ArnNotLike['aws:PrincipalArn']).toEqual(exemptions);
  });

  it('leaves the changes of the platform stack to the pipeline: tags, new audience, thumbprint', () => {
    // The pipeline changes the provider through the CloudFormation execution role. It tagged the provider in lab-platform run 37763755947.
    for (const action of ['iam:TagOpenIDConnectProvider', 'iam:UntagOpenIDConnectProvider', 'iam:AddClientIDToOpenIDConnectProvider', 'iam:UpdateOpenIDConnectProviderThumbprint', 'iam:GetOpenIDConnectProvider']) {
      expect((provider.Action as string[]).includes(action), action).toBe(false);
    }
  });
});

// A fake of the AWS CLI. It keeps the state of one organisation and records every call.
function fakeOrg(options: { existing?: { name: string; id: string; content: unknown; awsManaged?: boolean }[]; attached?: Record<string, string[]> } = {}) {
  const policies = (options.existing ?? []).map((p) => ({ ...p }));
  const attached: Record<string, string[]> = { ...(options.attached ?? {}) };
  const calls: string[][] = [];
  const aws: Aws = (args) => {
    calls.push(args);
    const [service, command] = args;
    const flag = (name: string) => args[args.indexOf(`--${name}`) + 1] as string;
    if (service !== 'organizations') throw new Error(`unexpected service ${service}`);
    switch (command) {
      case 'describe-organization':
        return JSON.stringify({ Organization: { MasterAccountId: '999999999999' } });
      case 'list-roots':
        return JSON.stringify({ Roots: [{ Id: 'r-abcd', PolicyTypes: [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }] }] });
      case 'list-policies':
        return JSON.stringify({ Policies: policies.map((p) => ({ Id: p.id, Name: p.name, AwsManaged: p.awsManaged ?? false })) });
      case 'describe-policy': {
        const policy = policies.find((p) => p.id === flag('policy-id'));
        return JSON.stringify({ Policy: { Content: JSON.stringify(policy?.content), PolicySummary: { Id: policy?.id, Name: policy?.name } } });
      }
      case 'create-policy': {
        const id = `p-new${policies.length}`;
        policies.push({ name: flag('name'), id, content: JSON.parse(flag('content')) });
        return JSON.stringify({ Policy: { PolicySummary: { Id: id, Name: flag('name') } } });
      }
      case 'update-policy': {
        const policy = policies.find((p) => p.id === flag('policy-id'));
        if (policy) policy.content = JSON.parse(flag('content'));
        return '{}';
      }
      case 'list-policies-for-target': {
        const ids = attached[flag('target-id')] ?? [];
        return JSON.stringify({ Policies: ids.map((id) => ({ Id: id, Name: policies.find((p) => p.id === id)?.name })) });
      }
      case 'attach-policy':
        attached[flag('target-id')] = [...(attached[flag('target-id')] ?? []), flag('policy-id')];
        return '';
      case 'detach-policy':
        attached[flag('target-id')] = (attached[flag('target-id')] ?? []).filter((id) => id !== flag('policy-id'));
        return '';
      case 'list-targets-for-policy': {
        const targets = Object.entries(attached).filter(([, ids]) => ids.includes(flag('policy-id'))).map(([id]) => ({ TargetId: id }));
        return JSON.stringify({ Targets: targets });
      }
      case 'delete-policy': {
        const index = policies.findIndex((p) => p.id === flag('policy-id'));
        if (index >= 0) policies.splice(index, 1);
        return '';
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
  const writes = () => calls.filter(([, command]) => /^(create|update|attach|detach|delete|enable)-/.test(command ?? ''));
  return { aws, calls, writes, policies, attached };
}

const log = () => undefined;
const roleGuard = policySpec('lab-pipeline-role-guard');
const roleGuardContent = compactPolicy(readFileSync(new URL(`../${roleGuard.file}`, import.meta.url), 'utf8'));

describe('applyPolicy', () => {
  it('creates the policy and attaches it to the target', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    expect(org.writes().map((c) => c[1])).toEqual(['create-policy', 'attach-policy']);
    expect(org.attached['444444444444']).toHaveLength(1);
  });

  it('creates a policy of the type SERVICE_CONTROL_POLICY with the name of the spec', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    const create = org.calls.find((c) => c[1] === 'create-policy') as string[];
    expect(create[create.indexOf('--name') + 1]).toBe('lab-pipeline-role-guard');
    expect(create[create.indexOf('--type') + 1]).toBe('SERVICE_CONTROL_POLICY');
  });

  it('is idempotent: the second run writes nothing', () => {
    const org = fakeOrg();
    const args = { aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev', 'test']) };
    applyPolicy(args);
    const before = org.writes().length;
    applyPolicy(args);
    expect(org.writes()).toHaveLength(before);
  });

  it('updates the policy when the content differs', () => {
    const org = fakeOrg({ existing: [{ name: 'lab-pipeline-role-guard', id: 'p-old', content: { Version: '2012-10-17', Statement: [] } }] });
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    expect(org.writes().map((c) => c[1])).toEqual(['update-policy', 'attach-policy']);
    expect(canonical(org.policies[0]?.content)).toBe(canonical(JSON.parse(roleGuardContent)));
  });

  it('attaches only to the account of the target', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['staging']) });
    const attach = org.calls.filter((c) => c[1] === 'attach-policy');
    expect(attach).toHaveLength(1);
    expect(attach[0]?.[attach[0].indexOf('--target-id') + 1]).toBe('222222222222');
  });

  it('refuses to run when the management account of the organisation is not the one in the env file', () => {
    const org = fakeOrg();
    const other = { ...ACCOUNTS, management: '123456789012' };
    expect(() =>
      applyPolicy({ aws: org.aws, log, accounts: other, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(other, roleGuard, ['dev']) }),
    ).toThrow(/management account/);
    expect(org.writes()).toHaveLength(0);
  });

  it('refuses a policy of that name that AWS manages', () => {
    const org = fakeOrg({ existing: [{ name: 'lab-pipeline-role-guard', id: 'p-aws', content: {}, awsManaged: true }] });
    expect(() =>
      applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) }),
    ).toThrow(/managed by AWS/);
    expect(org.writes()).toHaveLength(0);
  });

  it('refuses when the policy type is not enabled on the root', () => {
    const org = fakeOrg();
    const aws: Aws = (args) => (args[1] === 'list-roots' ? JSON.stringify({ Roots: [{ Id: 'r-abcd', PolicyTypes: [] }] }) : org.aws(args));
    expect(() =>
      applyPolicy({ aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) }),
    ).toThrow(/enable-policy-type/);
  });

  it('makes no write call in a dry run', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']), dryRun: true });
    expect(org.writes()).toHaveLength(0);
  });
});

describe('removePolicy', () => {
  it('detaches the policy from the target and keeps it', () => {
    const org = fakeOrg();
    const targets = resolveTargets(ACCOUNTS, roleGuard, ['dev', 'test']);
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets });
    removePolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    expect(org.attached['444444444444']).toEqual([]);
    expect(org.attached['111111111111']).toHaveLength(1);
    expect(org.policies).toHaveLength(1);
  });

  it('does nothing when the policy is not attached', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    const before = org.writes().length;
    removePolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, targets: resolveTargets(ACCOUNTS, roleGuard, ['test']) });
    expect(org.writes()).toHaveLength(before);
  });

  it('deletes the policy when asked and when no target is left', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']) });
    removePolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']), deletePolicy: true });
    expect(org.policies).toHaveLength(0);
  });

  it('keeps the policy when another account still uses it', () => {
    const org = fakeOrg();
    applyPolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, content: roleGuardContent, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev', 'test']) });
    removePolicy({ aws: org.aws, log, accounts: ACCOUNTS, spec: roleGuard, targets: resolveTargets(ACCOUNTS, roleGuard, ['dev']), deletePolicy: true });
    expect(org.policies).toHaveLength(1);
  });
});
