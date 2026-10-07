import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack.ts';
import type { Environment } from '../lib/config.ts';

const ISSUER = 'token.actions.githubusercontent.com';

function synth(environment: Environment, githubOwner = 'jross24') {
  const stack = new PlatformStack(new App(), { environment, githubOwner, githubOwnerId: '1001' });
  return { stack, template: Template.fromStack(stack) };
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

function allStatements(template: Template): Array<{ Action: string | string[]; Effect: string; Resource: unknown }> {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  return policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function actionsOf(template: Template): string[] {
  return allStatements(template).flatMap((statement) => [statement.Action].flat());
}

describe.each<Environment>(['test', 'staging', 'production'])('PlatformStack for %s', (environment) => {
  const { stack, template } = synth(environment);

  it('has the stack name of the environment', () => {
    expect(stack.stackName).toBe(`lab-platform-${environment}`);
  });

  it('creates one native GitHub OIDC provider with the STS audience', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: `https://${ISSUER}`,
      ClientIdList: ['sts.amazonaws.com'],
    });
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('creates one role named github-deploy with a one hour session', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'github-deploy',
      MaxSessionDuration: 3600,
    });
  });

  it('trusts only the OIDC provider, with exact aud and sub conditions', () => {
    const providerId = Object.keys(template.findResources('AWS::IAM::OIDCProvider'))[0];
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Principal: { Federated: { Ref: providerId } },
            Condition: {
              StringEquals: { [`${ISSUER}:aud`]: 'sts.amazonaws.com' },
              StringLike: { [`${ISSUER}:sub`]: `repo:jross24@1001/lab-*:environment:${environment}` },
            },
          },
        ],
      },
    });
  });

  it('gives the role no managed policy and exactly one inline policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.absent(),
      Policies: Match.absent(),
    });
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });

  it('outputs the role ARN', () => {
    const roleId = Object.keys(template.findResources('AWS::IAM::Role'))[0];
    template.hasOutput('DeployRoleArn', { Value: { 'Fn::GetAtt': [roleId, 'Arn'] } });
  });

  it('contains no account ID', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\d{12}/);
  });
});

describe('sub condition', () => {
  it('uses the githubOwner from the props', () => {
    const { template } = synth('staging', 'some-org');
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: { [`${ISSUER}:sub`]: 'repo:some-org@1001/lab-*:environment:staging' },
            }),
          }),
        ],
      },
    });
  });
});

describe.each<Environment>(['staging', 'production'])('permissions for %s', (environment) => {
  const { template } = synth(environment);

  it('allows sts:AssumeRole on the CDK bootstrap roles and an SSM read of /lab/* and nothing else', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Version: '2012-10-17', Statement: [assumeBootstrapRoles, readLabParameters] },
    });
    expect(actionsOf(template)).toEqual(['sts:AssumeRole', 'ssm:GetParameter', 'ssm:GetParameters']);
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
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          assumeBootstrapRoles,
          readLabParameters,
          {
            Action: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
            Effect: 'Allow',
            Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
          },
        ],
      },
    });
  });
});

describe.each<Environment>(['test', 'staging', 'production'])('SSM permission for %s', (environment) => {
  const { template } = synth(environment);

  it('reads parameters under /lab/ only, with no wildcard resource', () => {
    const ssm = allStatements(template).filter((statement) => [statement.Action].flat().some((a) => a.startsWith('ssm:')));
    expect(ssm).toEqual([readLabParameters]);
    expect(JSON.stringify(ssm)).not.toContain('parameter/*');
    expect(JSON.stringify(ssm)).not.toContain('"Resource":"*"');
  });

  it('allows no SSM write, list or delete action', () => {
    const ssmActions = actionsOf(template).filter((action) => action.startsWith('ssm:'));
    expect(ssmActions).toEqual(['ssm:GetParameter', 'ssm:GetParameters']);
  });
});
