import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack.ts';
import type { Environment } from '../lib/config.ts';

const ALL_ENVIRONMENTS: Environment[] = ['test', 'staging', 'production', 'dev'];

function synth(environment: Environment) {
  const stack = new PlatformStack(new App(), {
    environment,
    githubOwner: 'jross24',
    githubOwnerId: '1001',
    workflowRef: 'refs/heads/main',
  });
  return Template.fromStack(stack);
}

describe.each(ALL_ENVIRONMENTS)('Transaction Search in %s', (environment) => {
  const template = synth(environment);

  it('turns on CloudWatch Transaction Search and indexes every span', () => {
    template.resourceCountIs('AWS::XRay::TransactionSearchConfig', 1);
    template.hasResourceProperties('AWS::XRay::TransactionSearchConfig', { IndexingPercentage: 100 });
  });

  it('lets X-Ray write the spans into the log group aws/spans of this account and region only', () => {
    template.resourceCountIs('AWS::Logs::ResourcePolicy', 1);
    template.hasResourceProperties('AWS::Logs::ResourcePolicy', { PolicyName: 'lab-xray-can-write-spans' });
    const [policy] = Object.values(template.findResources('AWS::Logs::ResourcePolicy')) as {
      Properties: { PolicyDocument: unknown };
    }[];
    const text = JSON.stringify(policy?.Properties.PolicyDocument);
    expect(text).toContain('xray.amazonaws.com');
    expect(text).toContain('logs:PutLogEvents');
    expect(text).toContain('log-group:aws/spans:*');
    expect(text).toContain('aws:SourceAccount');
    expect(text).toContain('AWS::AccountId');
    expect(text).not.toMatch(/[0-9]{12}/);
  });

  it('creates the log group policy before the Transaction Search configuration', () => {
    const policyId = Object.keys(template.findResources('AWS::Logs::ResourcePolicy'))[0];
    template.hasResource('AWS::XRay::TransactionSearchConfig', { DependsOn: [policyId] });
  });

  it('keeps both resources when the stack or the resource goes away', () => {
    // A delete of the configuration switches tracing off for every service of the account.
    // A delete of the policy stops X-Ray from writing the spans.
    for (const type of ['AWS::XRay::TransactionSearchConfig', 'AWS::Logs::ResourcePolicy']) {
      template.hasResource(type, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    }
  });
});
