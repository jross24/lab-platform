import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack.ts';
import type { Environment } from '../lib/config.ts';

const ISSUER = 'token.actions.githubusercontent.com';
const ALL_ENVIRONMENTS: Environment[] = ['test', 'staging', 'production', 'dev'];
const PIPELINE_ENVIRONMENTS: Environment[] = ['test', 'staging', 'production'];

function synth(environment: Environment, githubOwner = 'jross24', workflowRef = 'refs/heads/main') {
  const stack = new PlatformStack(new App(), { environment, githubOwner, githubOwnerId: '1001', workflowRef });
  return { stack, template: Template.fromStack(stack) };
}

interface Statement {
  Action: string | string[];
  Effect: string;
  Resource: unknown;
}

function roleIdOf(template: Template, roleName: string): string {
  const ids = Object.keys(template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }));
  expect(ids, `role ${roleName}`).toHaveLength(1);
  return ids[0] as string;
}

function trustOf(template: Template, roleName: string): { Statement: Record<string, unknown>[] } {
  const role = Object.values(
    template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }),
  )[0] as { Properties: { AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] } } };
  return role.Properties.AssumeRolePolicyDocument;
}

// The statements of the one inline policy that CDK attaches to the role.
function statementsOf(template: Template, roleName: string): Statement[] {
  const roleId = roleIdOf(template, roleName);
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
    JSON.stringify(policy.Properties.Roles).includes(`"${roleId}"`),
  );
  expect(policies, `policy of ${roleName}`).toHaveLength(1);
  return (policies[0] as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
    .PolicyDocument.Statement;
}

function actionsOf(statements: Statement[]): string[] {
  return statements.flatMap((statement) => [statement.Action].flat());
}

function roleNames(template: Template): string[] {
  return Object.values(template.findResources('AWS::IAM::Role'))
    .map((role) => role.Properties.RoleName as string)
    .sort();
}

function expectedTrust(template: Template, conditions: { sub: string; jobWorkflowRef?: string }) {
  const providerId = Object.keys(template.findResources('AWS::IAM::OIDCProvider'))[0];
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRoleWithWebIdentity',
        Effect: 'Allow',
        Principal: { Federated: { Ref: providerId } },
        Condition: {
          StringEquals: { [`${ISSUER}:aud`]: 'sts.amazonaws.com' },
          StringLike: {
            [`${ISSUER}:sub`]: conditions.sub,
            ...(conditions.jobWorkflowRef ? { [`${ISSUER}:job_workflow_ref`]: conditions.jobWorkflowRef } : {}),
          },
        },
      },
    ],
  };
}

// The ARN of one CDK bootstrap role of the account that holds the stack.
function bootstrapRole(kind: 'deploy-role' | 'file-publishing-role') {
  return {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':iam::',
        { Ref: 'AWS::AccountId' },
        `:role/cdk-hnb659fds-${kind}-`,
        { Ref: 'AWS::AccountId' },
        '-',
        { Ref: 'AWS::Region' },
      ],
    ],
  };
}

const assumeBootstrapRoles = {
  Action: 'sts:AssumeRole',
  Effect: 'Allow',
  Resource: {
    'Fn::Join': [
      '',
      ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':role/cdk-hnb659fds-*'],
    ],
  },
};

// The end-to-end job reads the three URL parameters of the lab. It cannot write or list any parameter.
const readLabParameters = {
  Action: ['ssm:GetParameter', 'ssm:GetParameters'],
  Effect: 'Allow',
  Resource: {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':ssm:',
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        ':parameter/lab/*',
      ],
    ],
  },
};

// A pull request job reads the deployed template of a lab stack. This is all that `cdk diff --template` needs.
const readLabStacks = {
  Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
  Effect: 'Allow',
  Resource: {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':cloudformation:',
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        ':stack/lab-*/*',
      ],
    ],
  },
};

describe.each(ALL_ENVIRONMENTS)('PlatformStack for %s', (environment) => {
  const { stack, template } = synth(environment);

  it('has the stack name of the environment and termination protection', () => {
    expect(stack.stackName).toBe(`lab-platform-${environment}`);
    expect(stack.terminationProtection).toBe(true);
  });

  it('has a description that says what the stack is for', () => {
    expect(template.toJSON().Description).toBe(
      'Shared platform of the pipeline lab: the GitHub OIDC login and the roles of the pipelines. Deployed by the pipeline of lab-platform.',
    );
  });

  it('creates one native GitHub OIDC provider with the STS audience', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: `https://${ISSUER}`,
      ClientIdList: ['sts.amazonaws.com'],
    });
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('keeps the OIDC provider when the stack or the resource goes away', () => {
    // Without the provider no job can log in, and the pipeline cannot repair it.
    template.hasResource('AWS::IAM::OIDCProvider', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('creates the role github-pr-diff with a one hour session', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'github-pr-diff', MaxSessionDuration: 3600 });
  });

  it('lets only pull request jobs of the shared diff workflow assume github-pr-diff', () => {
    expect(trustOf(template, 'github-pr-diff')).toEqual(
      expectedTrust(template, {
        sub: 'repo:jross24@1001/lab-*:pull_request',
        jobWorkflowRef: 'jross24/lab-workflows/.github/workflows/diff.yml@refs/heads/main',
      }),
    );
  });

  it('gives github-pr-diff two read actions on the lab stacks and nothing else', () => {
    const statements = statementsOf(template, 'github-pr-diff');
    expect(statements).toEqual([readLabStacks]);
    expect(actionsOf(statements)).toEqual(['cloudformation:DescribeStacks', 'cloudformation:GetTemplate']);
  });

  it('contains no account ID', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\d{12}/);
  });

  it('has no managed policy and no policy with a wildcard resource', () => {
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    template.allResourcesProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent(), Policies: Match.absent() });
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain('"Resource":"*"');
    }
  });

  it('trusts only the OIDC provider, and only with exact audience and a sub of the owner and the lab repos', () => {
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
      const statements = role.Properties.AssumeRolePolicyDocument.Statement as {
        Action: string;
        Principal: Record<string, unknown>;
        Condition: { StringEquals: Record<string, string>; StringLike: Record<string, string> };
      }[];
      expect(statements).toHaveLength(1);
      const [statement] = statements as [(typeof statements)[number]];
      expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(Object.keys(statement.Principal)).toEqual(['Federated']);
      expect(statement.Condition.StringEquals).toEqual({ [`${ISSUER}:aud`]: 'sts.amazonaws.com' });
      const sub = statement.Condition.StringLike[`${ISSUER}:sub`] ?? '';
      expect(sub).toMatch(/^repo:jross24@1001\/lab-[a-z*]+(@\*)?:(environment:[a-z]+|pull_request|ref:refs\/heads\/main)$/);
    }
  });
});

describe.each(PIPELINE_ENVIRONMENTS)('github-deploy for %s', (environment) => {
  const { template } = synth(environment);

  it('is created next to github-pr-diff and nothing else', () => {
    expect(roleNames(template)).toEqual(['github-deploy', 'github-pr-diff']);
  });

  it('lets only jobs of a lab repo in the GitHub environment of the same name assume it', () => {
    expect(trustOf(template, 'github-deploy')).toEqual(
      expectedTrust(template, { sub: `repo:jross24@1001/lab-*:environment:${environment}` }),
    );
  });

  it('has the role name github-deploy with a one hour session', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'github-deploy', MaxSessionDuration: 3600 });
  });

  it('outputs the role ARN', () => {
    const roleId = roleIdOf(template, 'github-deploy');
    template.hasOutput('DeployRoleArn', { Value: { 'Fn::GetAtt': [roleId, 'Arn'] } });
  });
});

describe('sub condition', () => {
  it('uses the githubOwner from the props', () => {
    const { template } = synth('staging', 'some-org');
    expect(JSON.stringify(trustOf(template, 'github-deploy'))).toContain('repo:some-org@1001/lab-*:environment:staging');
    expect(JSON.stringify(trustOf(template, 'github-pr-diff'))).toContain('repo:some-org@1001/lab-*:pull_request');
    expect(JSON.stringify(trustOf(template, 'github-pr-diff'))).toContain(
      'some-org/lab-workflows/.github/workflows/diff.yml@refs/heads/main',
    );
  });
});

describe.each<Environment>(['staging', 'production'])('permissions for %s', (environment) => {
  const { template } = synth(environment);

  it('allows sts:AssumeRole on the CDK bootstrap roles and an SSM read of /lab/* and nothing else', () => {
    expect(statementsOf(template, 'github-deploy')).toEqual([assumeBootstrapRoles, readLabParameters]);
    expect(actionsOf(statementsOf(template, 'github-deploy'))).toEqual([
      'sts:AssumeRole',
      'ssm:GetParameter',
      'ssm:GetParameters',
    ]);
  });

  it('has no lock table and no DynamoDB permission', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/dynamodb/i);
  });
});

describe('permissions for test', () => {
  const { template } = synth('test');

  it('has the lock table', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        TableName: 'lab-test-lock',
        KeySchema: [{ AttributeName: 'lockId', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'lockId', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      },
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  it('allows the bootstrap roles, the SSM read and three item actions on the lock table only', () => {
    const tableId = Object.keys(template.findResources('AWS::DynamoDB::Table'))[0];
    expect(statementsOf(template, 'github-deploy')).toEqual([
      assumeBootstrapRoles,
      readLabParameters,
      {
        Action: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
      },
    ]);
  });

  it('gives the PR diff role no DynamoDB permission', () => {
    expect(JSON.stringify(statementsOf(template, 'github-pr-diff'))).not.toMatch(/dynamodb/i);
  });
});

describe.each(ALL_ENVIRONMENTS)('SSM permission for %s', (environment) => {
  const { template } = synth(environment);

  it('never allows an SSM write, list or delete action, and reads /lab/* only', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Statement[],
    );
    const ssmActions = actionsOf(statements).filter((action) => action.startsWith('ssm:'));
    expect(ssmActions.every((action) => action === 'ssm:GetParameter' || action === 'ssm:GetParameters')).toBe(true);
    const ssm = statements.filter((statement) => [statement.Action].flat().some((a) => a.startsWith('ssm:')));
    expect(JSON.stringify(ssm)).not.toContain('parameter/*');
  });
});

describe('the dev account', () => {
  const { template } = synth('dev');

  it('has the PR diff role and the two preview roles, and no deploy role and no lock table', () => {
    expect(roleNames(template)).toEqual(['github-pr-diff', 'github-preview', 'github-preview-sweeper']);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  it('lets only pull request jobs of the shared preview workflow assume github-preview', () => {
    expect(trustOf(template, 'github-preview')).toEqual(
      expectedTrust(template, {
        sub: 'repo:jross24@1001/lab-*:pull_request',
        jobWorkflowRef: 'jross24/lab-workflows/.github/workflows/preview.yml@refs/heads/main',
      }),
    );
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'github-preview', MaxSessionDuration: 3600 });
  });

  it('lets github-preview assume the CDK deploy role and the file publishing role of this account only', () => {
    const statements = statementsOf(template, 'github-preview');
    expect(statements).toEqual([
      { Action: 'sts:AssumeRole', Effect: 'Allow', Resource: [bootstrapRole('deploy-role'), bootstrapRole('file-publishing-role')] },
    ]);
  });

  it('lets only the scheduled sweeper workflow on main of lab-workflows assume github-preview-sweeper', () => {
    expect(trustOf(template, 'github-preview-sweeper')).toEqual(
      expectedTrust(template, {
        sub: 'repo:jross24@1001/lab-workflows@*:ref:refs/heads/main',
        jobWorkflowRef: 'jross24/lab-workflows/.github/workflows/preview-sweeper.yml@refs/heads/main',
      }),
    );
  });

  it('lets github-preview-sweeper assume the CDK deploy role only', () => {
    expect(statementsOf(template, 'github-preview-sweeper')).toEqual([
      { Action: 'sts:AssumeRole', Effect: 'Allow', Resource: bootstrapRole('deploy-role') },
    ]);
  });

  it('has no output of a role that a pipeline can use to deploy', () => {
    expect(Object.keys(template.toJSON().Outputs ?? {})).toEqual([]);
  });
});

describe('the roles that a pull request job can assume', () => {
  it.each(PIPELINE_ENVIRONMENTS)('can only read CloudFormation templates and stacks in %s', (environment) => {
    const { template } = synth(environment);
    const pullRequestRoles = Object.values(template.findResources('AWS::IAM::Role'))
      .filter((role) => JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes(':pull_request'))
      .map((role) => role.Properties.RoleName as string);
    expect(pullRequestRoles).toEqual(['github-pr-diff']);
    for (const name of pullRequestRoles) {
      const actions = actionsOf(statementsOf(template, name));
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => /^cloudformation:(Describe|Get)[A-Za-z]+$/.test(action))).toBe(true);
    }
  });

  it('can only assume the bootstrap roles of lab-dev, and never read or write anything else', () => {
    const { template } = synth('dev');
    const pullRequestRoles = Object.values(template.findResources('AWS::IAM::Role'))
      .filter((role) => JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes(':pull_request'))
      .map((role) => role.Properties.RoleName as string)
      .sort();
    expect(pullRequestRoles).toEqual(['github-pr-diff', 'github-preview']);
    expect(actionsOf(statementsOf(template, 'github-preview'))).toEqual(['sts:AssumeRole']);
  });
});

describe('the dev account while a workflow is under development', () => {
  const { template } = synth('dev', 'jross24', 'refs/heads/feat/*');

  it('lets the three roles follow the branch family and keeps every other condition', () => {
    expect(trustOf(template, 'github-pr-diff')).toEqual(
      expectedTrust(template, {
        sub: 'repo:jross24@1001/lab-*:pull_request',
        jobWorkflowRef: 'jross24/lab-workflows/.github/workflows/diff.yml@refs/heads/feat/*',
      }),
    );
    expect(trustOf(template, 'github-preview-sweeper')).toEqual(
      expectedTrust(template, {
        sub: 'repo:jross24@1001/lab-workflows@*:ref:refs/heads/feat/*',
        jobWorkflowRef: 'jross24/lab-workflows/.github/workflows/preview-sweeper.yml@refs/heads/feat/*',
      }),
    );
  });
});
