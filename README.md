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
| `Platform` | all four | CloudWatch Transaction Search: the log group policy `lab-xray-can-write-spans` and `AWS::XRay::TransactionSearchConfig`. Without them the services cannot send traces. See the section "Transaction Search". |
| `PlatformRoot` | `test`, `staging`, `production` | The role `github-platform-deploy`. The pipeline of this repository logs in with it. |
| `DevGuardrails` | `dev` | The permissions boundary `lab-dev-boundary` and the execution policy `lab-dev-cfn-execution`. They limit what a preview can create. |

The stacks have no fixed account. They deploy into the account of the AWS profile that you use.
All stacks have termination protection, so a wrong `cdk destroy` fails.

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
  Through them, a pull request can create the resource types of the `Dev` stages in `dev`, and no others. The CloudFormation execution role of the bootstrap has the custom policy `lab-dev-cfn-execution`.
  See "The guardrails of the dev account". The README of lab-workflows lists what stops a pull request from doing harm there, and what does not.
- `github-preview-sweeper` removes old previews. A scheduled workflow on `main` of lab-workflows assumes it. It can assume the CDK deploy role only.

## The guardrails of the dev account

A preview runs the CDK code of a pull request. CloudFormation then creates what that code describes.
CloudFormation works with the execution role of the CDK bootstrap: `cdk-hnb659fds-cfn-exec-role-<account id>-eu-west-2`.
By default this role has `AdministratorAccess`. So a template could create anything in `lab-dev`: an IAM user, a large instance, a role that reaches the CDK deploy role.

The stack `DevGuardrails` (`lab-platform-dev-guardrails`) removes this power with two managed policies. The code is in `lib/dev-policies.ts`.
The same stack holds a monthly budget that warns when the cost grows. See "The budget of the dev account".

| Policy | Where it is attached | What it limits |
| --- | --- | --- |
| `lab-dev-cfn-execution` | The execution role, through `cdk bootstrap` | What CloudFormation can create. |
| `lab-dev-boundary` | Every IAM role that a stack creates in `dev`, as the permissions boundary | What those roles can do while they run. |

### What the execution policy allows

It allows the resource types of the `Dev` stages and nothing else. Every allowed action has a resource limit, in the account and the region of the stack.

| Service | Allowed on | Notes |
| --- | --- | --- |
| API Gateway (HTTP APIs) | `/apis`, `/apis/*`, `/tags/*` | The five HTTP methods, and tag and untag. |
| AppConfig | Any AppConfig resource of the account | Create, update, delete and get. Start and stop a deployment. |
| CloudWatch | Alarms and dashboards with a name that starts with `lab-` | |
| CodeDeploy | Applications and deployment groups with a name that starts with `lab-` | |
| DynamoDB | Tables with a name that starts with `lab-` | Control plane only. The policy cannot read or write items. |
| Lambda | Functions with a name that starts with `lab-` | `lambda:AddPermission` only for the principal `apigateway.amazonaws.com`. So a function cannot be made public. |
| CloudWatch Logs | Log groups with a name that starts with `lab-`, and `aws/spans` | Resource policies for Transaction Search. |
| SSM | Parameters under `/lab/` | Read and write. The bootstrap version parameter: read only. |
| X-Ray | Transaction Search settings | |
| S3 | The asset bucket of the bootstrap | `GetObject` only. Lambda reads the code of a function there. |
| IAM | Roles with a name that starts with `lab-` | See the next section. |

CloudFormation names every resource `<stack name>-<logical id>-<random>`, and the stacks of the lab start with `lab-`. So the name limit does not block a normal stack.
A template that names a resource by hand, with a name that does not start with `lab-`, fails.

Two explicit denies stay on top, because a deny wins over every allow:

- **Protected identities.** Any IAM action on the roles `github-*`, `cdk-hnb659fds-*`, the roles of the single sign-on and `OrganizationAccountAccessRole`, on the two policies of this section, on OIDC and SAML providers, on users and on groups.
- **One region.** Any action outside the region of the stack, except IAM, which is global.

### Why a role must carry the boundary

A template can create an IAM role. Without a limit, that role could have `AdministratorAccess`, and a Lambda function could then assume it. That would give back everything that the execution policy took away.

So the execution policy allows `iam:CreateRole`, `iam:PutRolePermissionsBoundary`, `iam:PutRolePolicy` and `iam:UpdateAssumeRolePolicy` only when the request names the policy `lab-dev-boundary` as the boundary.
`iam:AttachRolePolicy` has the same condition, and it allows only two managed policies: `AWSLambdaBasicExecutionRole` and `AWSCodeDeployRoleForLambdaLimited`.
The policy never allows `iam:DeleteRolePermissionsBoundary`. A role keeps its boundary for its whole life.

IAM gives a role the permissions that both the policies of the role and the boundary allow. The boundary allows what the services use today: write logs and traces, call an API of the lab, read a feature flag, use the tables of the lab, write the rollback floor of core, call the functions of the lab and move an alias.
It has no `sts:AssumeRole`, no `iam:*` and no `cloudformation:*`, and it denies them. So the code of a preview cannot assume the CDK deploy role, even though the trust policy of that role accepts the account.

### How a stack gets the boundary

CDK adds a boundary to every role when the context key `@aws-cdk/core:permissionsBoundary` is set. The key needs an object: `{"name": "lab-dev-boundary"}`.
The flag `-c key=value` gives a string, and CDK ignores a string. The file `cdk.json` of the user does work, and so the service repositories need no change.

- A preview: the `build` job of `preview.yml` in lab-workflows writes `~/.cdk.json` before `cdk synth`.
- A laptop: see "Deploy a service to dev from a laptop".

The file is a convenience and not the protection. Code of a pull request can ignore it. In that case the execution policy refuses `iam:CreateRole`, and the deployment fails.

### Apply it

You need an administrator profile for the `dev` account. The order matters.

```
aws sso login --profile lab-dev

# 1. Create the two policies and the budget. The stack deploys with your own credentials, not through the execution role.
npx cdk deploy DevGuardrails -c environment=dev -c githubOwner=<owner> -c githubOwnerId=<owner id> --profile lab-dev

# 2. Deploy the baseline stacks again with the boundary (see the next section), so their roles carry it.

# 3. Bootstrap with the policy. The context values only stop the app from failing. Keep all other options.
npx cdk bootstrap aws://<account id>/eu-west-2 -c environment=dev -c githubOwner=<owner> -c githubOwnerId=<owner id> \
  --cloudformation-execution-policies arn:aws:iam::<account id>:policy/lab-dev-cfn-execution --profile lab-dev
```

Step 2 comes before step 3 on purpose. A role without the boundary cannot get a new policy through the execution role, and so a stack with such a role could not change.
Look at the result: `aws iam list-attached-role-policies --role-name cdk-hnb659fds-cfn-exec-role-<account id>-eu-west-2 --profile lab-dev` must list `lab-dev-cfn-execution` and not `AdministratorAccess`.

`DevGuardrails` uses the CDK credentials synthesizer. `cdk deploy` runs it with your own credentials and passes no execution role to CloudFormation. So the policy that the stack makes cannot block the stack.
The stack `Platform` of `dev` is different: see "Change the platform stack of dev".

### Deploy a service to dev from a laptop

A service repository does not set the boundary. Put the key in a `.cdk.json` in a temporary home folder, and run CDK with that home folder.
The folder holds only that file, so the key does not leak into your work for other accounts.

```
tmp="$(mktemp -d)"
echo '{"context":{"@aws-cdk/core:permissionsBoundary":{"name":"lab-dev-boundary"}}}' > "$tmp/.cdk.json"
# The temporary home has no AWS profile, so give CDK the credentials of the profile.
eval "$(aws configure export-credentials --profile lab-dev --format env)"
export AWS_REGION=eu-west-2
HOME="$tmp" npx cdk deploy -c dev=true -c namespace=my-test "Dev/*"
rm -rf "$tmp"
```

On Windows, Node reads `USERPROFILE` and not `HOME`. Set both to the temporary folder.
A `~/.cdk.json` in your real home folder also works. It then applies to every CDK deployment, also to other accounts. Those accounts have no such policy, so a role there fails.

### Change the platform stack of dev

The execution policy denies every IAM action on the roles `github-*` and on the OIDC provider. The stack `Platform` of `dev` holds exactly these resources.
CloudFormation keeps the execution role that it first used for a stack, so `cdk deploy Platform` runs with the restricted policy too. A change to one of those resources fails with `explicit deny`, and the stack can end in `UPDATE_ROLLBACK_FAILED`.

So a change to a `github-*` role or to the provider needs the steps below. Do them when no preview runs, because the account has no guardrail while the role has `AdministratorAccess`.

1. Put the bootstrap back (next section).
2. Run `npx cdk deploy Platform -c environment=dev -c githubOwner=<owner> -c githubOwnerId=<owner id> --profile lab-dev`.
3. Apply step 3 of "Apply it" again.

A change that touches no role or provider, for example a new resource of an allowed type, goes through the policy.
If a deployment of `Platform` ends in `UPDATE_ROLLBACK_FAILED` because of the deny, run `aws cloudformation continue-update-rollback --stack-name lab-platform-dev --resources-to-skip <logical id of the failed resource> --profile lab-dev`. Skip only a resource that did not change.

### Put the bootstrap back

A re-bootstrap keeps the options of the last run. So `cdk bootstrap` without an option does **not** restore `AdministratorAccess`. Name the policy:

```
npx cdk bootstrap aws://<account id>/eu-west-2 -c environment=dev -c githubOwner=<owner> -c githubOwnerId=<owner id> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess --profile lab-dev
```

While the role has `AdministratorAccess`, the guardrails do not protect the account. Apply the first command of "Apply it" again as soon as possible.

### Change the policy

The bootstrap names the policy by its ARN. So a change of the policy needs `cdk deploy DevGuardrails`, and no new bootstrap.

1. Add the actions to `lib/dev-policies.ts`, with a resource limit. The test file `test/dev-guardrails.test.ts` checks the size and the shape.
2. Run `npm test`. A managed policy can hold 6144 characters without white space. The execution policy is near that limit. If it does not fit, move a group of statements to a second policy and name both in the bootstrap command.
3. Deploy with `npx cdk deploy DevGuardrails ...` and the administrator profile.

To find the actions of a resource type, read the handler permissions: `aws cloudformation describe-type --type RESOURCE --type-name AWS::ApiGatewayV2::Stage --query Schema`. The lab added `apigateway:TagResource` this way, after a real failure.
The budget and its SNS topic need no statement here, because the stack that holds them deploys with your own credentials.

### What the real runs showed

| What | Result |
| --- | --- |
| The baseline stacks deployed again with the boundary (core, flags, account, web, catalogue), while the execution role still had `AdministratorAccess` | All ten roles of the stacks have the boundary. The three baseline URLs answer HTTP 200. |
| After the bootstrap: the catalogue baseline with a new `version` value | `UPDATE_COMPLETE`. Lambda, alias, CodeDeploy, alarms and SSM went through the new policy. |
| A copy of core with a namespace (DynamoDB table, three functions, the migration custom resource), then destroy | Created and destroyed. The first try failed on `apigateway:TagResource`. The policy has that action now. |
| A copy of flags with a namespace (AppConfig), then destroy | Created and destroyed. |
| A pull request preview of lab-svc-catalogue (label `preview`), then close without merge | The preview deployed through the new policy: [37850862914](https://github.com/jross24/lab-svc-catalogue/actions/runs/37850862914). Both of its roles carried the boundary. Closing the pull request destroyed the stack ([37851168973](https://github.com/jross24/lab-svc-catalogue/actions/runs/37851168973)): `DELETE_COMPLETE`, no role left. |
| A change of a `github-*` role in `Platform` of `dev`, with the bootstrap put back to `AdministratorAccess` and then applied again | Both deployments worked. After the second `cdk bootstrap` the execution role had only `lab-dev-cfn-execution`. |
| A stack with an SQS queue | `CREATE_FAILED`: `not authorized to perform: sqs:createqueue ... no identity-based policy allows the action`. |
| A stack with a role and no boundary | `CREATE_FAILED`: `not authorized to perform: iam:CreateRole`. |
| A stack with an IAM user | `CREATE_FAILED`: `explicit deny in an identity-based policy: lab-dev-cfn-execution`. |
| A stack with a role named `github-i43` | `CREATE_FAILED`: `explicit deny in an identity-based policy: lab-dev-cfn-execution`. |
| A tag added to the stack `Platform` of `dev`, deployed with `cdk deploy Platform` | `UPDATE_FAILED` on the OIDC provider: `not authorized to perform: iam:GetOpenIDConnectProvider ... explicit deny`. The stack went to `UPDATE_ROLLBACK_FAILED`, and `continue-update-rollback` with `--resources-to-skip` for the provider repaired it. No role or provider had changed. |
| A role with the boundary and an inline policy `Action: *, Resource: *` | Created. The policy simulator shows `sts:AssumeRole`, `iam:CreateUser` and `cloudformation:DeleteStack` as `explicitDeny`, and `sqs:CreateQueue` and `ec2:RunInstances` as `implicitDeny`, all with `AllowedByPermissionsBoundary: false`. |

### The budget of the dev account

`DevGuardrails` also holds a budget and an SNS topic. The code is in `lib/dev-budget.ts`.

| Part | Value |
| --- | --- |
| Budget `lab-dev-monthly` | Type cost, period month, limit 2 USD. It counts the usage and not the credits or refunds, so a credit does not hide the spend. |
| Alert 1 | The actual cost of the month is above 80 percent of the limit (1.60 USD). |
| Alert 2 | The forecast cost of the month is above 100 percent of the limit (2 USD). |
| Topic `lab-dev-budget-alerts` | Both alerts go to this topic. Its policy lets `budgets.amazonaws.com` publish, and only for a budget of the same account. It refuses a request without TLS. |

The topic has no subscriber. The code holds no email address, because this repository is public.
Until the owner adds a subscriber, an alert goes to the topic and nobody reads it.

**A budget warns. It does not stop spend.** The budget has no action. It never stops a service or removes a resource.
AWS updates the billing data up to three times a day, so an alert can come hours after the cost crossed the line.
AWS also needs some history of usage before it can forecast, so alert 2 can stay silent in a young account.

Subscribe your address with one command. It reads the account ID from your session, so no account ID is in the command:

```
aws sns subscribe --profile lab-dev --region eu-west-2 --protocol email --notification-endpoint <address>   --topic-arn "arn:aws:sns:eu-west-2:$(aws sts get-caller-identity --profile lab-dev --query Account --output text):lab-dev-budget-alerts"
```

AWS sends a mail to the address. Open the link in it to confirm. The subscription is not part of the stack, so `cdk deploy` does not remove it.
To stop the mails, run `aws sns unsubscribe --subscription-arn <arn> --profile lab-dev --region eu-west-2`. `aws sns list-subscriptions-by-topic` shows the ARN.

Deploy the budget with the same command as the policies (step 1 of "Apply it"). The topic stays unencrypted on purpose.
Budgets cannot publish to a topic that uses the AWS managed key of SNS, and the alert holds only a cost figure.

**Cost.** AWS Budgets is free for a budget without actions. A budget with actions is free for the first two in an account, and then costs 0.10 USD a day for each further one.
This budget has no action. The [pricing page](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) says: "You can monitor and receive notifications on your budgets free of charge" (checked on 2026-10-08).
SNS charges for requests and for deliveries, with a monthly free allowance. The budget sends at most two messages each month, and the topic has no subscriber, so nothing is delivered.

### What the guardrails do not stop

- A template can still create the allowed types, with any name that starts with `lab-`. It can fill the account with Lambda functions or DynamoDB tables, and it can delete a baseline stack through the CDK deploy role. The budget warns when the cost grows. It does not limit the cost.
- A function of a preview can write the rollback floor parameter of core. It cannot write other parameters.
- The policy does not limit the people with an administrator profile.
- The accounts `test`, `staging` and `production` still have the default execution role. Only `dev` runs unreviewed code.

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

## The pipeline of this repository

A merge to `main` deploys the stack `Platform` to `test`, then to `staging`, then to `production`. The workflow is `.github/workflows/deploy.yml`.
Each job runs in the GitHub environment of its account. The environment `production` has a required reviewer, so the last job waits until he approves.

```
merge to main -> deploy-test -> deploy-staging -> deploy-production (waits for the reviewer)
```

Each job does four things:

1. It logs in as `github-platform-deploy` (OIDC). That role can assume the CDK deploy role and the CDK file publishing role of its own account, and nothing else.
2. It runs `cdk deploy Platform`.
3. It logs in again as `github-deploy`, the role of the release workflows, from a job in the same GitHub environment.
4. It checks that the login gave `github-deploy`.

Step 3 is the safety net. A change of this stack can break the login of every service release: a wrong trust policy, a lost OIDC provider.
If step 3 fails in `test`, `staging` and `production` never start. A bad change stops in the account that has the least value.

A pull request shows the effect first. The workflow `ci` posts one `cdk diff` comment for each account (`test`, `staging`, `production` and `dev`), from the shared workflow of [lab-workflows](https://github.com/jross24/lab-workflows).
The comment compares the pull request with the stacks that run now. The stateful change guard applies: a delete or a replacement of a stateful resource, such as the lock table in `test`, fails the check until someone adds the label `destructive-change-approved`.

### The hard part: the pipeline changes the role that it runs as

The pipeline logs in with a role that this repository creates. A change to that role could lock the pipeline out, and then the pipeline could not repair itself. The lab decided this:

| What | Who changes it | How |
| --- | --- | --- |
| `github-deploy`, `github-pr-diff`, the lock table (stack `Platform`) | The pipeline | A merge to `main` |
| The OIDC provider (stack `Platform`) | The pipeline, but it cannot remove it | `DeletionPolicy: Retain` keeps the real provider if a change removes it from the template |
| `github-platform-deploy`, the role of the pipeline (stack `PlatformRoot`) | A person, from a laptop | `cdk deploy PlatformRoot` with an administrator profile |
| The `dev` account (stack `Platform`) | A person, from a laptop | `cdk deploy Platform` with the profile `lab-dev` |
| The guardrails of the `dev` account (stack `DevGuardrails`) | A person, from a laptop | `cdk deploy DevGuardrails` with the profile `lab-dev` |
| The CDK bootstrap roles | A person, from a laptop | `cdk bootstrap` |
| The GitHub environments, the rulesets, the secrets | A person | The GitHub settings |

So the pipeline may change almost everything about the platform, but not the role it logs in with. The code of that role is in `lib/root-stack.ts`, in a stack that `deploy.yml` never names.
A pull request that changes `lib/root-stack.ts` still shows a diff for `PlatformRoot` in its comment. That is the sign that someone must deploy by hand after the merge.

What this separation does and does not give:

- **It prevents accidents.** A change to the usual file of the platform cannot change the trust policy of the pipeline by mistake.
- **It does not stop a malicious change.** The pipeline deploys through the CDK bootstrap roles. The CloudFormation execution role has `AdministratorAccess`. A pull request that a reviewer merges could attach a policy to the pipeline role from `Platform`.
  The protection is the review of the pull request, the `cdk diff` comment, and the required reviewer on `production`. It is not a technical block.
- **A technical block would be a service control policy.** It would deny every change to `role/github-platform-deploy` except for the administrator role of the SSO. The lab does not build it. A wrong policy at the level of the organisation could lock out the administrator.

### Why the dev account is not in the pipeline

The `dev` account holds the baseline services and the previews. It has no release path. The roles in it change rarely, and a bad change there harms nothing but the previews.
A person deploys it from a laptop. The comment of a pull request still shows the diff for `dev`, so a person sees when `dev` is behind `main`.

### Recover from a bad change

1. **The deployment fails.** CloudFormation rolls the stack back to the last good state. The job fails and the next environment does not start. Fix the code and merge again.
2. **The deployment works but breaks something** (for example, a service release cannot log in). The check in step 3 should stop it in `test`. If it did not, revert the pull request and merge the revert. The pipeline deploys the old state.
3. **The pipeline cannot log in** (a wrong change to `PlatformRoot`, or the role is gone). Use the second way in: the single sign-on administrator profile of each account.
   ```
   aws sso login --profile lab-<environment>
   git checkout <last good commit>
   npx cdk deploy Platform PlatformRoot -c environment=<environment> -c githubOwner=<owner> -c githubOwnerId=<owner id> --profile lab-<environment>
   ```
   Then run the workflow `login check` and the workflow `deploy` by hand to prove that the pipeline works again.
4. **The OIDC provider is gone.** Deploy `Platform` from the laptop. This creates the provider again.
5. **The single sign-on is gone too.** The management account has the role `OrganizationAccountAccessRole` in each member account. This is the last resort.

Both stacks have termination protection, so a wrong `cdk destroy` fails before it removes anything.

### What the real runs showed

| Run | What happened |
| --- | --- |
| [37762284445](https://github.com/jross24/lab-platform/actions/runs/37762284445), the merge of the pipeline itself | `deploy-test`, `deploy-staging` and `deploy-production` ran in this order. The production job waited for the reviewer. Each job logged in as `github-platform-deploy` and printed `(no changes)`. Then each job logged in as `github-deploy` from its GitHub environment, and the check passed. |
| [37762933185](https://github.com/jross24/lab-platform/actions/runs/37762933185), a description for the stack | The run was green and changed nothing. **CloudFormation does not treat a change of the description alone as a change.** `cdk deploy` printed `(no changes)`, and `describe-stacks` still showed no description. |
| [37763755947](https://github.com/jross24/lab-platform/actions/runs/37763755947), a tag on the stack and on every taggable resource | A real change went through all three accounts. The tag is on the stack and on the roles and the OIDC provider, and the description from the run before arrived with it. The `cdk diff` comment of the pull request had shown exactly these three in-place changes. |

Two more facts from the first pull request of the pipeline:

- The four `cdk diff` calls of one run used the same name for their artefacts, so each job read the templates of another account and showed every resource as new.
  The shared workflow now puts the key of the call in the name.
- `PlatformRoot` depends on `Platform`. `cdk diff --template` refuses to compare two stacks, so the shared workflow passes `--exclusively`.

The `dev` account was not part of these runs. A person deployed it from the laptop after the merge, and the comment of the pull request had shown that it was behind.

### Required checks

The ruleset of `main` requires `check`, `dependencies`, `secrets`, `actionlint` and, for `test`, `staging` and `production`, the four jobs of the diff (`gate`, `fetch`, `compute`, `report`).
The diff jobs are all required, and not only `report`. If `fetch` fails, `compute` and `report` are skipped, and GitHub counts a skipped required check as passed.

## Transaction Search: the tracing setting of the account

The services send their spans to the OTLP endpoint of X-Ray. The endpoint accepts spans only when CloudWatch Transaction Search is on in the account.
The setting belongs to the whole account and the whole region, not to one service. All four services use it, so the stack `Platform` owns it, in all four accounts ([#27](https://github.com/jross24/lab-platform/issues/27)).
Core owned it before the move. The README of [lab-svc-core](https://github.com/jross24/lab-svc-core) now points here.

`lib/transaction-search.ts` makes two resources:

| Resource | What it does |
| --- | --- |
| CloudWatch Logs resource policy `lab-xray-can-write-spans` | Lets X-Ray write into the log group `aws/spans` of this account and region. It checks the source account and the source ARN, so another account cannot make X-Ray write here. |
| `AWS::XRay::TransactionSearchConfig` | Turns Transaction Search on. X-Ray then writes each span as a log event into `aws/spans`, and it indexes 100 percent of the spans as traces that `aws xray batch-get-traces` finds. |

The configuration depends on the policy, so the policy comes first. Both resources have `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.

### What the setting does, and what it costs

- **The indexing is 100 percent. This is a lab value.** AWS indexes 1 percent of the spans for free and charges for the rest. The lab has little traffic, so the cost is small. **A real team lowers the value.**
- **The sampling is not set in this stack, and it stays as it is.** Each service decides which requests make a trace. Today every request of the lab makes one. **A real team lowers the sampling too.**
  The two settings work in series: the sampling decides how many spans exist, and the indexing decides how many of them become traces that the X-Ray API can find.
- **The first creation takes about 6 minutes.** The resource waits until the setting is active. The rehearsal measured 6 min 5 s. A job of the pipeline has a limit of 20 minutes, which is enough.
- **A delete switches tracing off for all four services.** The destination goes to `XRay` after about 20 seconds, and the delete itself takes about 6 minutes.
  The exports of the services then fail with a `WARN` log line. The requests still work. So both resources have the retain policies:
  a change that removes them from the template leaves them in the account. The stack also has termination protection.
  To switch tracing off on purpose, run `aws xray update-trace-segment-destination --destination XRay` by hand.
- **The log group `aws/spans` is not a resource of the stack.** AWS creates it by itself. The stack cannot set its retention (the default is 30 days), and it cannot delete it.

### Why a second stack cannot take the setting by a plain deploy

Both resources have a fixed identity in the account: the name of the policy, and the account ID for the configuration.
Core owned them until the move. The lab tried the ways to move them in the `lab-dev` account, with its own test stacks:

| Way | Result |
| --- | --- |
| A stack removes a resource with `Retain` set in the same update | CloudFormation uses the policy of the **old** template, so the resource is deleted. `Retain` must be deployed one release before the removal. |
| A new stack creates the policy while a policy with that name exists | The change set fails: `AWS::EarlyValidation::ResourceExistenceCheck`. |
| A new stack creates the configuration while the setting is on | `CREATE_FAILED` with `HandlerErrorCode: AlreadyExists`. The rollback does not delete the setting when the resource has `Retain`. |
| A stack imports the setting while another stack still owns it | Refused: `already exists in stack ...`. |
| `--import-existing-resources` on the change set | It imports the policy, because the policy has a custom name. It does not import the configuration, because that has no name. |
| The old stack deletes both, then the new stack creates both | Works, but tracing is off for about 13 minutes in each account (6 min 7 s delete, 6 min 38 s create). |
| The old stack removes both with `Retain`, then the new stack imports both | Works. The import took 32 seconds, and the destination stayed `CloudWatchLogs` and `ACTIVE`. **No gap.** |

The last way is the one the lab uses. Core took two releases: the first set `Retain`, and the second removed the two resources. Then a person imports them into this stack.
The pipeline of this repository cannot do that step, because it runs `cdk deploy` and never makes a change set of type `IMPORT`.

### Take over a setting that exists already

Use this when an account has the setting but no stack owns it. This is the case after the second core release, and in a new account where someone set it up by hand.
Do it before the pipeline deploys the resources. A plain deploy of the stack fails with `AlreadyExists` and rolls back. That is safe, and it also shows that the import is missing.

1. Check out the commit that has `lib/transaction-search.ts` and run `npm ci`.
2. Make sure that the stack `Platform` of the account is up to date. `cdk diff Platform` must show only the two new resources, because an import cannot change other resources.
3. Write the file `mapping.json`. It maps the logical IDs to the real identifiers. The logical IDs are the same in every account. Use the account ID of the profile.

   ```
   {
     "TransactionSearchXRayCanWriteSpans50F3D9CC": { "PolicyName": "lab-xray-can-write-spans" },
     "TransactionSearchConfig7812D3D6": { "AccountId": "<account id>" }
   }
   ```

   Run the import with an administrator profile:

   ```
   npx cdk import Platform -c environment=<environment> -c githubOwner=<owner> -c githubOwnerId=<owner id> \
     --resource-mapping mapping.json --profile lab-<environment>
   ```

   The command shows the resources, asks for confirmation, and makes a change set of type `IMPORT`. Do not commit `mapping.json`: it holds an account ID. The stack gets the resources without any change to them.
4. Run `cdk diff Platform` again. It must show no difference. Then check that the setting is still on:
   `aws xray get-trace-segment-destination --profile lab-<environment>` must show `"Destination": "CloudWatchLogs"` and `"Status": "ACTIVE"`.

The accounts `test`, `staging` and `production` then deploy with `(no changes)` from the pipeline. The `dev` account is deployed by hand: run `cdk deploy Platform` after the import.

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

Do the same for `staging` and `production`, each with its own profile and its own `environment` value. The `dev` account has `Platform` and `DevGuardrails`. Its guardrails need extra steps: see "The guardrails of the dev account".
The profile selects the account, so make sure that the profile and the `environment` value match.

An account can hold only one OIDC provider for GitHub. If the account already has one, the deployment fails.
