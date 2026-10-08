# lab-platform

This repository holds the shared platform resources of the pipeline lab.
It is an AWS CDK app in TypeScript. You deploy it one time into each account: `test`, `staging`, `production` and `dev`.

Each account gets the stack `Platform` (`lab-platform-<environment>`).
`test`, `staging` and `production` also get the stack `PlatformRoot` (`lab-platform-root-<environment>`).

| Stack | Account | What it creates |
| --- | --- | --- |
| `Platform` | all four | The IAM OIDC identity provider for GitHub Actions. The role `github-pr-diff`. |
| `Platform` | `test`, `staging`, `production` | The role `github-deploy`. A release workflow assumes it to deploy. |
| `Platform` | `test` | The DynamoDB table `lab-test-lock`. Releases use it as a lock, so only one release uses the shared Test environment at a time. |
| `Platform` | `dev` | The roles `github-preview` and `github-preview-sweeper`. They run the temporary environment of a pull request. |
| `PlatformRoot` | `test`, `staging`, `production` | The role `github-platform-deploy`. The pipeline of this repository logs in with it. |

The stacks have no fixed account. They deploy into the account of the AWS profile that you use.
Both stacks have termination protection, so a wrong `cdk destroy` fails.

## Why OIDC and no stored AWS key

A stored AWS access key is a long-lived secret. If it leaks, an attacker can use it until someone rotates it.

With OIDC, GitHub signs a short-lived token for each workflow job. AWS checks the signature and the claims in the token.
If they match the trust policy of the role, AWS gives the job temporary credentials. The credentials expire after one hour at most.
No AWS key is stored in GitHub, so there is no key to leak or rotate.

## What the trust policies check

The token from GitHub has many claims. Every role in this repository checks these three:

- `aud` must be `sts.amazonaws.com`.
- `sub` names the repository and what the job runs for. It has the immutable form `repo:<owner>@<owner id>/<repo>@<repo id>:<rest>`.
- `job_workflow_ref` names the workflow file that holds the job, with its ref. The roles for pull requests and for the pipeline check it. The role `github-deploy` does not.

GitHub puts numeric IDs in the `sub` claim of a new repository, for example `repo:my-org@1234/lab-web@5678:environment:test`.
A name can move to a new owner, but an ID cannot, so the patterns include the owner ID.
Read the real prefix of a repository with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`.

| Role | `sub` pattern (after `repo:<owner>@<owner id>/`) | `job_workflow_ref` |
| --- | --- | --- |
| `github-deploy` | `lab-*:environment:<environment>` | not checked |
| `github-pr-diff` | `lab-*:pull_request` | `<owner>/lab-workflows/.github/workflows/diff.yml@refs/heads/main` |
| `github-preview` (dev) | `lab-*:pull_request` | `<owner>/lab-workflows/.github/workflows/preview.yml@refs/heads/main` |
| `github-preview-sweeper` (dev) | `lab-workflows@*:ref:refs/heads/main` | `<owner>/lab-workflows/.github/workflows/preview-sweeper.yml@refs/heads/main` |
| `github-platform-deploy` | `lab-platform@*:environment:<environment>` | `<owner>/lab-platform/.github/workflows/deploy.yml@refs/heads/main` |

A job gets the `environment:<name>` form only if it names a GitHub environment. A job that names none and runs for a pull request gets `pull_request`.
So a job can assume `github-deploy` only if the repository belongs to `<owner>`, its name starts with `lab-`, and the job runs in the GitHub environment with the same name as the AWS environment.
Protection rules on the GitHub environment, such as a required reviewer, then control who can deploy.

### The claim `job_workflow_ref` is a real second lock

The `sub` claim of a pull request job is the same for every workflow in the repository.
A person who can push a branch can write a new workflow file with `id-token: write` and ask for the role.
The `sub` check alone would allow that. So the roles for pull requests also check `job_workflow_ref`.

AWS does not list `job_workflow_ref` as a condition key for GitHub in the pages about OIDC federation.
The lab tested it with real jobs. IAM accepts the key in the trust policy, and it enforces it. The test used `github-pr-diff` in the `dev` account:

| Job | `job_workflow_ref` of the token | Result |
| --- | --- | --- |
| The shared file `diff.yml`, on the allowed ref | `jross24/lab-workflows/.github/workflows/diff.yml@refs/heads/probe/oidc-claims` | Login worked |
| Another file of lab-workflows, same ref | `jross24/lab-workflows/.github/workflows/probe-other.yml@refs/heads/probe/oidc-claims` | `Not authorized to perform sts:AssumeRoleWithWebIdentity` |
| A workflow of the service repository itself | `jross24/lab-svc-catalogue/.github/workflows/probe.yml@refs/pull/7/merge` | `Not authorized to perform sts:AssumeRoleWithWebIdentity` |
| The shared file `diff.yml`, while the trust named `refs/heads/main` | `.../diff.yml@refs/heads/probe/oidc-claims` | `Not authorized to perform sts:AssumeRoleWithWebIdentity` |

So only the code of the file on `main` of lab-workflows can use the role. To change that code, a person must merge a pull request into lab-workflows.

## The role `github-pr-diff`

Every service repository shows a `cdk diff` against Production on its pull requests. The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains the workflow.
This role is the AWS side of it. It has two actions on the stacks with a name that starts with `lab-`, in its own account:

```
cloudformation:DescribeStacks
cloudformation:GetTemplate
```

The lab looked for the smallest set. `cdk diff --method template` makes exactly three calls: it assumes the bootstrap lookup role, it reads the bootstrap version in SSM, and it calls `DescribeStacks` and `GetTemplate`.
The lookup role has the managed policy `ReadOnlyAccess`. That is much more than a diff needs, because it can read the data of S3 buckets and DynamoDB tables.
So the workflow does not use the CDK CLI with this role. It runs two AWS CLI calls, and it compares the templates offline with `cdk diff --template`.
The role cannot assume another role. It has a session limit of one hour.

**What a pull request can read with it.** The template and the outputs of any lab stack in the account.
A template has names, settings and environment variables. It holds no secret by the rules of the lab: a secret lives in Secrets Manager, and the template holds only a reference.
The released templates are also public already: the release workflow attaches `cdk-out-<tag>.zip` to a public GitHub release.
So the role shows nothing that a visitor cannot download.

**Why a pull request cannot misuse it.**
- The pull request code runs in a job with no AWS credentials. The job with the role runs only the shared workflow file.
- A pull request from a fork gets no OIDC token. GitHub gives a fork no secret and no `id-token`. The workflow skips the diff and writes a notice.
- The role cannot write anything. A unit test checks that every action starts with `cloudformation:Describe` or `cloudformation:Get`.
- A person with write access to a service repository can still read the templates. They can already read the code, and the released templates are public.

**What this does not solve.** A person who can merge into lab-workflows can change `diff.yml`, and so can use the role to read any lab template.
The role is read-only, so the damage is the leak of templates. The lab accepts this.

## The roles of the dev account

The `dev` account is the developer account. It has no release path and no `github-deploy` role.
It holds the baseline copy of the four services and the temporary environments of pull requests.

- `github-preview` is for the preview of a pull request. It can assume the CDK deploy role and the CDK file publishing role of the account, and nothing else.
  Through them, a pull request can create any resource in `dev`. The CloudFormation execution role of the bootstrap has the managed policy `AdministratorAccess`.
  The README of lab-workflows lists what stops a pull request from doing harm there, and what does not.
- `github-preview-sweeper` removes old previews. A scheduled workflow on `main` of lab-workflows assumes it. It can assume the CDK deploy role only.

## The `workflowRef` context value

The trust policies name `refs/heads/main`. To test a change of `diff.yml` or `preview.yml` before it reaches `main`, the `dev` account can follow a branch.
Give the context value `workflowRef`, for example:

```
npx cdk deploy Platform -c environment=dev -c githubOwner=<owner> -c githubOwnerId=<id> -c 'workflowRef=refs/heads/feat/*' --profile lab-dev
```

The value is accepted only for `environment=dev`. For `test`, `staging` and `production` the app throws, so no one can widen those trust policies by mistake.
After the test, deploy `dev` again without the value.

## The stack `PlatformRoot`: the identity of the pipeline

The pipeline of this repository logs in with `github-platform-deploy`. It must not change this role.
A wrong change to the role would lock the pipeline out, and the pipeline could not repair it.
So the role lives in its own stack. The pipeline deploys `Platform` and never `PlatformRoot`. A person deploys `PlatformRoot` from a laptop.

The OIDC provider is in `Platform`, because it was there first. It has `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
If a change removes or replaces it in the template, the real provider stays in the account, and the login keeps working.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

`npm run synth` synthesises the stacks for `test`. For a different environment, give the context values:

```
npx cdk synth -c environment=staging -c githubOwner=<github-owner> -c githubOwnerId=<github-owner-id>
```

`environment` must be `test`, `staging`, `production` or `dev`. Synthesis does not need AWS credentials.

## First deployment, and the manual steps

The first deployment into each account runs by hand, from a laptop, with an administrator profile.
The pipeline cannot do it, because the pipeline needs a role to log in, and this repository creates the roles.

Run `cdk bootstrap` first. It creates the bootstrap roles that the deploy roles assume. Then deploy the stacks. `Platform` comes first.

```
npx cdk bootstrap --profile lab-test
npx cdk deploy Platform -c environment=test -c githubOwner=<github-owner> -c githubOwnerId=<github-owner-id> --profile lab-test
npx cdk deploy PlatformRoot -c environment=test -c githubOwner=<github-owner> -c githubOwnerId=<github-owner-id> --profile lab-test
```

Do the same for `staging` and `production`, each with its own profile and its own `environment` value. The `dev` account has `Platform` only.
The profile selects the account, so make sure that the profile and the `environment` value match.

An account can hold only one OIDC provider for GitHub. If the account already has one, the deployment fails.
