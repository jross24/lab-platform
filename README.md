# lab-platform

This repository holds the shared platform resources of the pipeline lab.
It is an AWS CDK app in TypeScript with one stack, `PlatformStack`.
You deploy the stack one time into each environment account: `test`, `staging` and `production`.

The stack creates these resources:

- The IAM OIDC identity provider for GitHub Actions.
- The IAM role `github-deploy`. A GitHub Actions workflow assumes this role to deploy.
- In `test` only, the DynamoDB table `lab-test-lock`. Releases use it as a lock, so only one release uses the shared Test environment at a time.

The stack has no fixed account. It deploys into the account of the AWS profile that you use.

## Why OIDC and no stored AWS key

A stored AWS access key is a long-lived secret. If it leaks, an attacker can use it until someone rotates it.

With OIDC, GitHub signs a short-lived token for each workflow job. AWS checks the signature and the claims in the token.
If they match the trust policy of the role, AWS gives the job temporary credentials. The credentials expire after one hour at most.
No AWS key is stored in GitHub, so there is no key to leak or rotate.

## What the `sub` condition restricts

The token from GitHub has a `sub` claim. It says which repository and which GitHub environment the job runs in.
The trust policy of `github-deploy` accepts only this pattern:

```
repo:<githubOwner>@<githubOwnerId>/lab-*:environment:<environment>
```

GitHub adds numeric IDs to the claim for new repositories, for example `repo:my-org@1234/lab-web@5678:environment:test`.
A name can move to a new owner, but an ID cannot, so the pattern includes the owner ID.
Read the real prefix of a repository with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`.

So a job can assume the role only if both of these are true:

- The repository belongs to `<githubOwner>` and its name starts with `lab-`.
- The job runs in the GitHub environment with the same name as the AWS environment.

A job that names no GitHub environment cannot assume the role, whatever branch it runs on.
Protection rules on the GitHub environment, such as a required reviewer, then control who can deploy.

The role itself can do very little. It can assume the CDK bootstrap roles (`cdk-hnb659fds-*`) of its own account.
In `test` it can also put, get and delete items in the lock table.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

`npm run synth` synthesises the stack for `test`. For a different environment, give the context values:

```
npx cdk synth -c environment=staging -c githubOwner=<github-owner> -c githubOwnerId=<github-owner-id>
```

`environment` must be `test`, `staging` or `production`. Synthesis does not need AWS credentials.

## First deployment

The first deployment into each account runs by hand, from a laptop, with an administrator profile.
The pipeline cannot do it, because the pipeline needs the `github-deploy` role to log in, and this stack creates that role.

Run `cdk bootstrap` first. It creates the bootstrap roles that `github-deploy` assumes. Then deploy the stack.

```
npx cdk bootstrap --profile lab-test
npx cdk deploy -c environment=test -c githubOwner=<github-owner> -c githubOwnerId=<github-owner-id> --profile lab-test
```

Do the same for `staging` and `production`, each with its own profile and its own `environment` value.
The profile selects the account, so make sure that the profile and the `environment` value match.

An account can hold only one OIDC provider for GitHub. If the account already has one, the deployment fails.
