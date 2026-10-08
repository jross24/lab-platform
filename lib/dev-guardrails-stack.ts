import { Aws, CliCredentialsStackSynthesizer, Stack, Tags } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { Config } from './config.ts';
import { DevBudget } from './dev-budget.ts';
import {
  BOUNDARY_POLICY_NAME,
  EXECUTION_POLICY_NAME,
  boundaryPolicy,
  executionPolicy,
  type PolicyDocument,
} from './dev-policies.ts';

// The two managed policies that fence the dev account. See lib/dev-policies.ts for what they allow, and the README.
//
// This stack must NOT be deployed through the CloudFormation execution role that it configures. That role cannot
// create or change these policies, by design. So the stack uses the synthesizer that deploys with the credentials of
// the person who runs `cdk deploy`. Use an administrator profile of the dev account.
export class DevGuardrailsStack extends Stack {
  constructor(scope: Construct, config: Config) {
    if (config.environment !== 'dev') {
      throw new Error('The guardrails are for the dev account only. The other accounts have no previews.');
    }
    super(scope, 'DevGuardrails', {
      stackName: 'lab-platform-dev-guardrails',
      description:
        'Guardrails of the dev account: the permissions boundary of the service roles, the execution policy of CloudFormation and the monthly budget. Deployed by hand with an administrator profile.',
      terminationProtection: true,
      // The CDK CLI deploys with the credentials of the person. It assumes no bootstrap role and passes no execution
      // role to CloudFormation. It still needs the asset bucket of the bootstrap, so bootstrap the account first.
      synthesizer: new CliCredentialsStackSynthesizer(),
    });
    const tags = { 'lab-managed-by': 'lab-platform' };
    for (const [key, value] of Object.entries(tags)) Tags.of(this).add(key, value);

    // Pseudo parameters, so the template has no account ID and works in any account.
    const ctx = { partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION };

    new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: BOUNDARY_POLICY_NAME,
      description: 'Permissions boundary of every IAM role that a stack in the dev account creates.',
      document: toDocument(boundaryPolicy(ctx)),
    });
    new iam.ManagedPolicy(this, 'Execution', {
      managedPolicyName: EXECUTION_POLICY_NAME,
      description: 'Permissions of the CloudFormation execution role of the CDK bootstrap in the dev account.',
      document: toDocument(executionPolicy(ctx)),
    });

    // The budget lives here and not in Platform. This stack deploys with the credentials of the person, so the
    // execution policy needs no statement for Budgets or SNS, and it stays under its size limit.
    new DevBudget(this, 'Budget', { tags });
  }
}

function toDocument(document: PolicyDocument): iam.PolicyDocument {
  return iam.PolicyDocument.fromJson(document);
}
