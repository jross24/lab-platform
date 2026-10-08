import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DevGuardrailsStack } from '../lib/dev-guardrails-stack.ts';
import { boundaryPolicy, executionPolicy, type PolicyContext, type PolicyDocument } from '../lib/dev-policies.ts';

const ctx: PolicyContext = { partition: 'aws', account: '111111111111', region: 'eu-west-2' };
const BOUNDARY_ARN = 'arn:aws:iam::111111111111:policy/lab-dev-boundary';

// IAM counts the characters of a managed policy without white space. One policy can hold 6144 of them.
const MANAGED_POLICY_LIMIT = 6144;

function sizeOf(document: PolicyDocument): number {
  return JSON.stringify(document).replace(/\s/g, '').length;
}

function statements(document: PolicyDocument, effect: 'Allow' | 'Deny') {
  return document.Statement.filter((statement) => statement.Effect === effect);
}

function actionsOf(statement: PolicyDocument['Statement'][number]): string[] {
  return [statement.Action ?? []].flat();
}

function allowedActions(document: PolicyDocument): string[] {
  return statements(document, 'Allow').flatMap(actionsOf);
}

function withAction(document: PolicyDocument, action: string) {
  return statements(document, 'Allow').filter((statement) => actionsOf(statement).includes(action));
}

// IAM matches an action name against a pattern with * in it, and ignores the case.
function allows(document: PolicyDocument, action: string): boolean {
  return allowedActions(document).some((pattern) => new RegExp(`^${pattern.split('*').join('.*')}$`, 'i').test(action));
}

describe('boundary policy', () => {
  const boundary = boundaryPolicy(ctx);

  it('fits in one managed policy', () => {
    expect(sizeOf(boundary)).toBeLessThanOrEqual(MANAGED_POLICY_LIMIT);
  });

  it('allows what the roles of the services use at run time', () => {
    const actions = allowedActions(boundary);
    for (const action of [
      'logs:PutLogEvents',
      'xray:PutTraceSegments',
      'execute-api:Invoke',
      'appconfig:StartConfigurationSession',
      'appconfig:GetLatestConfiguration',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'ssm:PutParameter',
      'ssm:DeleteParameter',
      'lambda:InvokeFunction',
      'lambda:GetFunction',
      'lambda:UpdateAlias',
      'cloudwatch:DescribeAlarms',
    ]) {
      expect(actions, action).toContain(action);
    }
  });

  it('lets a role write only the rollback floor of core, in the baseline and in a namespace', () => {
    const [statement] = withAction(boundary, 'ssm:PutParameter');
    expect(statement?.Resource).toEqual([
      'arn:aws:ssm:eu-west-2:111111111111:parameter/lab/core/min-rollback-version',
      'arn:aws:ssm:eu-west-2:111111111111:parameter/lab/ns/*/core/min-rollback-version',
    ]);
  });

  it('never allows a wildcard action', () => {
    for (const action of allowedActions(boundary)) {
      expect(action, action).not.toMatch(/\*/);
    }
  });

  it('allows no way to assume a role, to change IAM or to change a stack', () => {
    for (const action of allowedActions(boundary)) {
      expect(action, action).not.toMatch(/^(iam|sts|cloudformation|organizations|account):/);
    }
  });

  it('denies those services too, so a later wrong Allow cannot open them', () => {
    const denied = statements(boundary, 'Deny').flatMap(actionsOf);
    expect(denied).toEqual(expect.arrayContaining(['iam:*', 'sts:*', 'cloudformation:*']));
  });

  it('limits every resource to the account and the region of the stack', () => {
    for (const statement of statements(boundary, 'Allow')) {
      for (const resource of [statement.Resource ?? []].flat()) {
        // X-Ray and CloudWatch alarm reads have no resource level.
        if (resource === '*') continue;
        expect(resource, resource).toMatch(/^arn:aws:[a-z0-9-]+:eu-west-2:111111111111:/);
      }
    }
  });

  it('allows a star resource only for the actions that have no resource level', () => {
    const star = statements(boundary, 'Allow')
      .filter((statement) => [statement.Resource ?? []].flat().includes('*'))
      .flatMap(actionsOf)
      .sort();
    expect(star).toEqual(['cloudwatch:DescribeAlarms', 'xray:PutTelemetryRecords', 'xray:PutTraceSegments']);
  });
});

describe('execution policy', () => {
  const policy = executionPolicy(ctx);

  it('fits in one managed policy', () => {
    expect(sizeOf(policy)).toBeLessThanOrEqual(MANAGED_POLICY_LIMIT);
  });

  // The list comes from `aws cloudformation describe-type` for each resource type of the Dev stages (handler permissions).
  // The first deployment of a copy of core failed on apigateway:TagResource, so the list holds what CloudFormation calls.
  it.each([
    'apigateway:POST',
    'apigateway:TagResource',
    'apigateway:UntagResource',
    'appconfig:StartDeployment',
    'appconfig:CreateHostedConfigurationVersion',
    'cloudwatch:PutMetricAlarm',
    'cloudwatch:PutDashboard',
    'codedeploy:CreateDeploymentGroup',
    'codedeploy:RegisterApplicationRevision',
    'dynamodb:CreateTable',
    'dynamodb:UpdateContinuousBackups',
    'iam:PutRolePolicy',
    'lambda:CreateFunction',
    'lambda:PublishVersion',
    'lambda:UpdateAlias',
    'lambda:AddPermission',
    'lambda:InvokeFunction',
    'logs:CreateLogGroup',
    'logs:PutRetentionPolicy',
    'logs:DescribeIndexPolicies',
    'ssm:PutParameter',
    'ssm:AddTagsToResource',
    'xray:UpdateTraceSegmentDestination',
  ])('allows %s, which CloudFormation calls for a resource type of the Dev stages', (action) => {
    expect(allows(policy, action)).toBe(true);
  });

  it('allows no action with a wildcard for IAM, STS or Organizations', () => {
    for (const action of allowedActions(policy)) {
      expect(action, action).not.toMatch(/^(iam|sts|organizations|account|kms|s3|ec2|sqs|sns|secretsmanager):\*$/);
      expect(action, action).not.toBe('*');
    }
  });

  it('allows every IAM action that adds permission only with the boundary', () => {
    for (const action of [
      'iam:CreateRole',
      'iam:PutRolePermissionsBoundary',
      'iam:PutRolePolicy',
      'iam:AttachRolePolicy',
      'iam:UpdateAssumeRolePolicy',
    ]) {
      const found = withAction(policy, action);
      expect(found, action).toHaveLength(1);
      expect(found[0]?.Condition?.StringEquals?.['iam:PermissionsBoundary'], action).toBe(BOUNDARY_ARN);
    }
  });

  it('limits the roles to the names that start with lab-', () => {
    for (const action of ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DeleteRole', 'iam:PassRole']) {
      const found = withAction(policy, action);
      expect(found, action).toHaveLength(1);
      expect([found[0]?.Resource].flat(), action).toEqual(['arn:aws:iam::111111111111:role/lab-*']);
    }
  });

  it('attaches only the two managed policies that the services use', () => {
    const [statement] = withAction(policy, 'iam:AttachRolePolicy');
    expect(statement?.Condition?.StringEquals?.['iam:PolicyARN']).toEqual([
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited',
    ]);
  });

  it('can never remove the boundary of a role', () => {
    expect(allowedActions(policy)).not.toContain('iam:DeleteRolePermissionsBoundary');
  });

  it('passes a role only to Lambda and CodeDeploy', () => {
    const [statement] = withAction(policy, 'iam:PassRole');
    expect(statement?.Condition?.StringEquals?.['iam:PassedToService']).toEqual([
      'lambda.amazonaws.com',
      'codedeploy.amazonaws.com',
    ]);
  });

  it('allows no IAM policy, user, group, access key or identity provider change', () => {
    for (const action of allowedActions(policy)) {
      expect(action, action).not.toMatch(
        /^iam:(Create|Update|Delete|Put|Attach|Detach|Add|Remove|Set|Upload)(Policy|PolicyVersion|User|Group|AccessKey|LoginProfile|OpenIDConnectProvider|SAMLProvider|InstanceProfile|ServiceLinkedRole|UserPolicy|GroupPolicy)/,
      );
    }
  });

  it('denies every IAM action on the roles of the platform, the bootstrap and the SSO', () => {
    const deny = statements(policy, 'Deny').find((statement) => actionsOf(statement).includes('iam:*'));
    expect(deny).toBeDefined();
    expect([deny?.Resource].flat()).toEqual(
      expect.arrayContaining([
        'arn:aws:iam::111111111111:role/github-*',
        'arn:aws:iam::111111111111:role/cdk-hnb659fds-*',
        'arn:aws:iam::111111111111:role/aws-reserved/*',
        'arn:aws:iam::111111111111:policy/lab-dev-boundary',
        'arn:aws:iam::111111111111:policy/lab-dev-cfn-execution',
        'arn:aws:iam::111111111111:oidc-provider/*',
        'arn:aws:iam::111111111111:user/*',
      ]),
    );
  });

  it('denies every action outside the region of the stack, except IAM', () => {
    const deny = statements(policy, 'Deny').find((statement) => statement.NotAction !== undefined);
    expect(deny?.NotAction).toEqual(['iam:*']);
    expect(deny?.Condition?.StringNotEquals?.['aws:RequestedRegion']).toBe('eu-west-2');
  });

  it('allows a star resource only for a short list of read and global actions', () => {
    const star = statements(policy, 'Allow')
      .filter((statement) => [statement.Resource ?? []].flat().includes('*'))
      .flatMap(actionsOf);
    for (const action of star) {
      expect(action, action).toMatch(/:(List|Describe|Get)[A-Za-z*]*$|^xray:|^logs:(Put|Delete)ResourcePolicy$/);
    }
  });

  it('allows the resource types of the Dev stages and no other', () => {
    const services = new Set(allowedActions(policy).map((action) => action.split(':')[0]));
    expect([...services].sort()).toEqual([
      'apigateway',
      'appconfig',
      'cloudwatch',
      'codedeploy',
      'dynamodb',
      'iam',
      'lambda',
      'logs',
      's3',
      'ssm',
      'xray',
    ]);
  });

  it('lets Lambda functions be exposed to API Gateway only', () => {
    const [statement] = withAction(policy, 'lambda:AddPermission');
    expect(statement?.Condition?.StringEquals?.['lambda:Principal']).toBe('apigateway.amazonaws.com');
  });

  it('reads the code of the functions from the asset bucket of the bootstrap, and nothing else in S3', () => {
    const s3 = statements(policy, 'Allow').filter((statement) => actionsOf(statement).some((a) => a.startsWith('s3:')));
    expect(s3).toHaveLength(1);
    expect(actionsOf(s3[0] as PolicyDocument['Statement'][number]).sort()).toEqual(['s3:GetObject', 's3:GetObjectVersion']);
    expect([s3[0]?.Resource].flat()).toEqual(['arn:aws:s3:::cdk-hnb659fds-assets-111111111111-eu-west-2/*']);
  });
});

describe('DevGuardrailsStack', () => {
  const config = { environment: 'dev', githubOwner: 'jross24', githubOwnerId: '1001', workflowRef: 'refs/heads/main' } as const;
  const stack = new DevGuardrailsStack(new App(), config);
  const template = Template.fromStack(stack);

  it('is named lab-platform-dev-guardrails and has termination protection', () => {
    expect(stack.stackName).toBe('lab-platform-dev-guardrails');
    expect(stack.terminationProtection).toBe(true);
  });

  it('holds exactly the two managed policies, with fixed names', () => {
    const policies = Object.values(template.findResources('AWS::IAM::ManagedPolicy'));
    expect(policies.map((policy) => policy.Properties.ManagedPolicyName).sort()).toEqual([
      'lab-dev-boundary',
      'lab-dev-cfn-execution',
    ]);
  });

  it('holds nothing else that costs money or grants access, except the budget and its topic', () => {
    const types = new Set(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type));
    expect([...types].sort()).toEqual([
      'AWS::Budgets::Budget',
      'AWS::IAM::ManagedPolicy',
      'AWS::SNS::Topic',
      'AWS::SNS::TopicPolicy',
    ]);
  });

  it('has no bootstrap version rule, so a later bootstrap version cannot block a deployment', () => {
    const json = template.toJSON() as { Parameters?: unknown; Rules?: unknown };
    expect(json.Parameters).toBeUndefined();
    expect(json.Rules).toBeUndefined();
  });

  it('reads the account and the region of the target from the stack, not from the code', () => {
    const json = JSON.stringify(template.toJSON().Resources);
    expect(json).toContain('AWS::AccountId');
    expect(json).toContain('AWS::Region');
    expect(json).not.toMatch(/\b\d{12}\b/);
  });
});
