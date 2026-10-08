import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { Config } from './config.ts';
import {
  BOOTSTRAP_QUALIFIER,
  GITHUB_ISSUER,
  STS_AUDIENCE,
  environmentSub,
  githubRole,
  labWorkflowsMainSub,
  pullRequestSub,
  workflowRefOf,
} from './github.ts';

// The ARN of one CDK bootstrap role of the account that holds the stack.
function bootstrapRoleArn(stack: Stack, kind: 'deploy-role' | 'file-publishing-role'): string {
  return stack.formatArn({
    service: 'iam',
    region: '',
    resource: 'role',
    resourceName: `cdk-${BOOTSTRAP_QUALIFIER}-${kind}-${stack.account}-${stack.region}`,
  });
}

// The part of the platform that the pipeline of this repository deploys.
// The role that the pipeline runs as is in PlatformRootStack, so this stack cannot change it.
export class PlatformStack extends Stack {
  constructor(scope: Construct, config: Config) {
    const { environment } = config;
    // A stack that holds the login of every pipeline must survive a wrong `cdk destroy`.
    super(scope, 'Platform', {
      stackName: `lab-platform-${environment}`,
      description:
        'Shared platform of the pipeline lab: the GitHub OIDC login and the roles of the pipelines. Deployed by the pipeline of lab-platform.',
      terminationProtection: true,
    });

    // Every resource that takes a tag shows which repository manages it. A tag changes a resource in place.
    Tags.of(this).add('lab-managed-by', 'lab-platform');

    const provider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: `https://${GITHUB_ISSUER}`,
      clientIds: [STS_AUDIENCE],
      // Without the provider no job can log in, and the pipeline cannot repair that. So a change that removes
      // or replaces the resource in the template must leave the real provider in the account.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    if (environment !== 'dev') {
      this.addDeployRole(config, provider);
    }

    this.addPullRequestDiffRole(config, provider);

    if (environment === 'dev') {
      this.addPreviewRoles(config, provider);
    }
  }

  // The release path of the service repositories deploys with this role.
  private addDeployRole(config: Config, provider: iam.IOidcProvider): void {
    const { environment } = config;
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_ISSUER}:aud`]: STS_AUDIENCE },
        StringLike: { [`${GITHUB_ISSUER}:sub`]: environmentSub(config, environment) },
      }),
    });

    // The role holds no deploy permission itself. CDK does the work through the bootstrap roles.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          this.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: `cdk-${BOOTSTRAP_QUALIFIER}-*`,
          }),
        ],
      }),
    );

    // The end-to-end job reads the URL of each application from SSM. The role cannot write, list or delete.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: 'lab/*',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    if (environment === 'test') {
      // A lock: releases use the shared Test environment one at a time.
      const lockTable = new dynamodb.Table(this, 'TestLock', {
        tableName: 'lab-test-lock',
        partitionKey: { name: 'lockId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'expiresAt',
        removalPolicy: RemovalPolicy.DESTROY,
      });

      deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
          resources: [lockTable.tableArn],
        }),
      );
    }

    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }

  // A pull request job reads the deployed template of a lab stack, so the pull request can show a diff.
  // The role has two read actions. It cannot write, and it cannot assume another role.
  private addPullRequestDiffRole(config: Config, provider: iam.IOidcProvider): void {
    const role = githubRole(this, 'PullRequestDiffRole', provider, 'github-pr-diff', {
      sub: pullRequestSub(config),
      jobWorkflowRef: workflowRefOf(config, 'lab-workflows', 'diff.yml'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
        resources: [
          this.formatArn({
            service: 'cloudformation',
            resource: 'stack',
            resourceName: 'lab-*/*',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
  }

  // The developer account has no release path. It has a preview deployment for pull requests and a sweeper.
  private addPreviewRoles(config: Config, provider: iam.IOidcProvider): void {
    const preview = githubRole(this, 'PreviewRole', provider, 'github-preview', {
      sub: pullRequestSub(config),
      jobWorkflowRef: workflowRefOf(config, 'lab-workflows', 'preview.yml'),
    });
    // CDK deploys through the bootstrap roles. The deploy role calls CloudFormation. The file publishing role uploads the assets.
    preview.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRoleArn(this, 'deploy-role'), bootstrapRoleArn(this, 'file-publishing-role')],
      }),
    );

    // The sweeper removes the previews that nobody needs. It runs on a schedule, on main of lab-workflows.
    const sweeper = githubRole(this, 'PreviewSweeperRole', provider, 'github-preview-sweeper', {
      sub: labWorkflowsMainSub(config),
      jobWorkflowRef: workflowRefOf(config, 'lab-workflows', 'preview-sweeper.yml'),
    });
    sweeper.addToPolicy(
      new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [bootstrapRoleArn(this, 'deploy-role')] }),
    );
  }
}
