import { Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { Config } from './config.ts';
import { BOOTSTRAP_QUALIFIER, GITHUB_ISSUER, STS_AUDIENCE, platformEnvironmentSub, workflowRefOf } from './github.ts';

// The identity that the pipeline of this repository runs as.
//
// The pipeline deploys PlatformStack. It must not change the role that it logs in with. A wrong change to that
// role would lock the pipeline out, and the pipeline could not repair it. So this role lives in a stack that the
// pipeline never deploys. A person deploys this stack from a laptop with an administrator profile.
export class PlatformRootStack extends Stack {
  constructor(scope: Construct, config: Config) {
    const { environment } = config;
    if (environment === 'dev') {
      throw new Error('There is no pipeline role in the dev account. The pipeline does not deploy to dev.');
    }
    super(scope, 'PlatformRoot', { stackName: `lab-platform-root-${environment}`, terminationProtection: true });

    // PlatformStack creates the provider. The role finds it by its ARN, so the two stacks need no export.
    const provider = iam.OidcProviderNative.fromOidcProviderArn(
      this,
      'GitHubOidcProvider',
      this.formatArn({ service: 'iam', region: '', resource: 'oidc-provider', resourceName: GITHUB_ISSUER }),
    );

    const role = new iam.Role(this, 'PlatformDeployRole', {
      roleName: 'github-platform-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_ISSUER}:aud`]: STS_AUDIENCE },
        StringLike: {
          [`${GITHUB_ISSUER}:sub`]: platformEnvironmentSub(config, environment),
          [`${GITHUB_ISSUER}:job_workflow_ref`]: workflowRefOf(config, 'lab-platform', 'deploy.yml'),
        },
      }),
    });

    // Like github-deploy, the role holds no deploy permission itself. CDK does the work through the bootstrap roles.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy-role', 'file-publishing-role'].map((kind) =>
          this.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: `cdk-${BOOTSTRAP_QUALIFIER}-${kind}-${this.account}-${this.region}`,
          }),
        ),
      }),
    );
  }
}
