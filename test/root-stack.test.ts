import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformRootStack } from '../lib/root-stack.ts';
import type { Environment } from '../lib/config.ts';

const ISSUER = 'token.actions.githubusercontent.com';
const PIPELINE_ENVIRONMENTS: Environment[] = ['test', 'staging', 'production'];

function synth(environment: Environment, githubOwner = 'jross24') {
  const stack = new PlatformRootStack(new App(), { environment, githubOwner, githubOwnerId: '1001', workflowRef: 'refs/heads/main' });
  return { stack, template: Template.fromStack(stack) };
}

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

describe.each(PIPELINE_ENVIRONMENTS)('PlatformRootStack for %s', (environment) => {
  const { stack, template } = synth(environment);

  it('has its own stack name and termination protection', () => {
    expect(stack.stackName).toBe(`lab-platform-root-${environment}`);
    expect(stack.terminationProtection).toBe(true);
  });

  it('holds one role and its policy and nothing else', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    expect(Object.keys(template.toJSON().Resources as object)).toHaveLength(2);
  });

  it('names the role github-platform-deploy with a one hour session', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'github-platform-deploy', MaxSessionDuration: 3600 });
  });

  it('lets only the deploy workflow of lab-platform on main, in the GitHub environment of this account, assume it', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Principal: {
              Federated: {
                'Fn::Join': [
                  '',
                  ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:oidc-provider/${ISSUER}`],
                ],
              },
            },
            Condition: {
              StringEquals: { [`${ISSUER}:aud`]: 'sts.amazonaws.com' },
              StringLike: {
                [`${ISSUER}:sub`]: `repo:jross24@1001/lab-platform@*:environment:${environment}`,
                [`${ISSUER}:job_workflow_ref`]: 'jross24/lab-platform/.github/workflows/deploy.yml@refs/heads/main',
              },
            },
          },
        ],
      },
    });
  });

  it('lets the role assume the CDK deploy role and the file publishing role of this account, and nothing else', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: [bootstrapRole('deploy-role'), bootstrapRole('file-publishing-role')],
          },
        ],
      },
    });
  });

  it('contains no account ID', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\d{12}/);
  });
});

describe('PlatformRootStack', () => {
  it('uses the githubOwner from the props', () => {
    const { template } = synth('production', 'some-org');
    expect(JSON.stringify(template.toJSON())).toContain('repo:some-org@1001/lab-platform@*:environment:production');
    expect(JSON.stringify(template.toJSON())).toContain('some-org/lab-platform/.github/workflows/deploy.yml@refs/heads/main');
  });

  it('does not exist for the dev account', () => {
    expect(() => synth('dev')).toThrow(/no pipeline role in the dev account/);
  });
});
