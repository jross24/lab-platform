import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { Config } from './config.ts';

const GITHUB_ISSUER = 'token.actions.githubusercontent.com';
const STS_AUDIENCE = 'sts.amazonaws.com';
const BOOTSTRAP_QUALIFIER = 'hnb659fds';

export class PlatformStack extends Stack {
  constructor(scope: Construct, config: Config) {
    const { environment, githubOwner } = config;
    super(scope, 'Platform', { stackName: `lab-platform-${environment}` });

    const provider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: `https://${GITHUB_ISSUER}`,
      clientIds: [STS_AUDIENCE],
    });

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_ISSUER}:aud`]: STS_AUDIENCE },
        StringLike: {
          [`${GITHUB_ISSUER}:sub`]: `repo:${githubOwner}/lab-*:environment:${environment}`,
        },
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
}
