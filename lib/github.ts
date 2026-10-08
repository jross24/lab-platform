import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { Config, Environment } from './config.ts';

export const GITHUB_ISSUER = 'token.actions.githubusercontent.com';
export const STS_AUDIENCE = 'sts.amazonaws.com';
export const BOOTSTRAP_QUALIFIER = 'hnb659fds';

// The `sub` claim that GitHub puts in the token, in the immutable form: repo:<owner>@<owner id>/<repo>@<repo id>:<rest>.
// The owner ID makes the pattern safe when a name moves to a new owner.
// A `*` in the repository part matches the repository ID, for example lab-web@5678.
export function environmentSub({ githubOwner, githubOwnerId }: Config, environment: Environment): string {
  return `repo:${githubOwner}@${githubOwnerId}/lab-*:environment:${environment}`;
}

// A job that names no GitHub environment and runs for a pull request gets this sub claim.
export function pullRequestSub({ githubOwner, githubOwnerId }: Config): string {
  return `repo:${githubOwner}@${githubOwnerId}/lab-*:pull_request`;
}

// A job of lab-workflows that runs on one branch (main) and names no environment gets this sub claim.
export function labWorkflowsMainSub({ githubOwner, githubOwnerId, workflowRef }: Config): string {
  return `repo:${githubOwner}@${githubOwnerId}/lab-workflows@*:ref:${workflowRef}`;
}

// A job of lab-platform in the GitHub environment of one account.
export function platformEnvironmentSub({ githubOwner, githubOwnerId }: Config, environment: Environment): string {
  return `repo:${githubOwner}@${githubOwnerId}/lab-platform@*:environment:${environment}`;
}

// The claim job_workflow_ref names the workflow file that runs the job, with its ref.
// For a job in a reusable workflow it names the reusable workflow, and not the workflow of the caller.
// So a role that sets this condition accepts only the code of that file on main.
export function workflowRefOf({ githubOwner, workflowRef }: Config, repository: string, file: string): string {
  return `${githubOwner}/${repository}/.github/workflows/${file}@${workflowRef}`;
}

export interface TrustConditions {
  readonly sub: string;
  readonly jobWorkflowRef: string;
}

// A role that only jobs of GitHub Actions can assume, with an exact audience, a sub and a workflow file.
export function githubRole(
  scope: Construct,
  id: string,
  provider: iam.IOidcProvider,
  roleName: string,
  conditions: TrustConditions,
): iam.Role {
  return new iam.Role(scope, id, {
    roleName,
    maxSessionDuration: Duration.hours(1),
    assumedBy: new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: { [`${GITHUB_ISSUER}:aud`]: STS_AUDIENCE },
      StringLike: {
        [`${GITHUB_ISSUER}:sub`]: conditions.sub,
        [`${GITHUB_ISSUER}:job_workflow_ref`]: conditions.jobWorkflowRef,
      },
    }),
  });
}
