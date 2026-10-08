import { BOOTSTRAP_QUALIFIER } from './github.ts';

// The two managed policies that fence the dev account (lab-platform#43, option 1).
//
// The CDK bootstrap gives CloudFormation the role cdk-hnb659fds-cfn-exec-role-*. Out of the box it has
// AdministratorAccess, so a template that a pull request deploys can create anything in the account.
// - The execution policy replaces AdministratorAccess. It allows the resource types of the Dev stages, only for
//   names that start with lab-, and only in one region.
// - The boundary caps every IAM role that the execution policy creates. The execution policy refuses to create a
//   role, or to give it a policy, unless the role carries the boundary. So a role of a stack cannot be more
//   powerful than the boundary, whatever its template says.

export const BOUNDARY_POLICY_NAME = 'lab-dev-boundary';
export const EXECUTION_POLICY_NAME = 'lab-dev-cfn-execution';

// The values of the account that the policies protect. The stack passes tokens, the tests pass plain strings.
export interface PolicyContext {
  readonly partition: string;
  readonly account: string;
  readonly region: string;
}

type ConditionBlock = Record<string, Record<string, string | string[]>>;

export interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action?: string[];
  readonly NotAction?: string[];
  readonly Resource: string | string[];
  readonly Condition?: ConditionBlock;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: PolicyStatement[];
}

// Services that name no region in the ARN of a resource (IAM) or no account (CloudWatch dashboards) have their own helpers.
function regional({ partition, account, region }: PolicyContext, service: string, resource: string): string {
  return `arn:${partition}:${service}:${region}:${account}:${resource}`;
}

function accountWide({ partition, account }: PolicyContext, service: string, resource: string): string {
  return `arn:${partition}:${service}::${account}:${resource}`;
}

export function boundaryArn(ctx: PolicyContext): string {
  return accountWide(ctx, 'iam', `policy/${BOUNDARY_POLICY_NAME}`);
}

function executionPolicyArn(ctx: PolicyContext): string {
  return accountWide(ctx, 'iam', `policy/${EXECUTION_POLICY_NAME}`);
}

// The most that any role of a lab service can do at run time. This is what the services use today.
// The roles must not assume another role, change IAM or change a stack, so the document has no such action.
export function boundaryPolicy(ctx: PolicyContext): PolicyDocument {
  const lambdas = regional(ctx, 'lambda', 'function:lab-*');
  const tables = regional(ctx, 'dynamodb', 'table/lab-*');
  const logGroups = regional(ctx, 'logs', 'log-group:*');

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'WriteLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [logGroups, `${logGroups}:*`],
      },
      {
        // X-Ray has no resource level for these actions.
        Sid: 'WriteTraces',
        Effect: 'Allow',
        Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        Resource: '*',
      },
      {
        // A service calls another service of the lab through its API.
        Sid: 'CallLabApis',
        Effect: 'Allow',
        Action: ['execute-api:Invoke'],
        Resource: regional(ctx, 'execute-api', '*'),
      },
      {
        Sid: 'ReadFlags',
        Effect: 'Allow',
        Action: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'],
        Resource: regional(ctx, 'appconfig', 'application/*'),
      },
      {
        Sid: 'UseLabTables',
        Effect: 'Allow',
        Action: [
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:UpdateItem',
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
        ],
        Resource: [tables, `${tables}/index/*`, `${tables}/stream/*`],
      },
      {
        // The migration step of core writes the rollback floor. It is the only parameter that a role writes at run time.
        Sid: 'WriteRollbackFloor',
        Effect: 'Allow',
        Action: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        Resource: [
          regional(ctx, 'ssm', 'parameter/lab/core/min-rollback-version'),
          regional(ctx, 'ssm', 'parameter/lab/ns/*/core/min-rollback-version'),
        ],
      },
      {
        // The custom resource provider of core calls its own functions. CodeDeploy moves the alias of a function.
        Sid: 'UseLabFunctions',
        Effect: 'Allow',
        Action: ['lambda:InvokeFunction', 'lambda:GetFunction', 'lambda:GetAlias', 'lambda:UpdateAlias', 'lambda:GetProvisionedConcurrencyConfig'],
        Resource: lambdas,
      },
      {
        // CodeDeploy reads the alarms that guard a gradual release.
        Sid: 'ReadAlarms',
        Effect: 'Allow',
        Action: ['cloudwatch:DescribeAlarms'],
        Resource: '*',
      },
      {
        Sid: 'NeverTouchIdentityOrStacks',
        Effect: 'Deny',
        Action: ['iam:*', 'sts:*', 'cloudformation:*', 'organizations:*', 'account:*'],
        Resource: '*',
      },
    ],
  };
}

// What CloudFormation may do for the stacks of the dev account.
// The service actions come from the handlers of the resource types (`aws cloudformation describe-type`).
export function executionPolicy(ctx: PolicyContext): PolicyDocument {
  const { partition, account, region } = ctx;
  const boundary = boundaryArn(ctx);
  const labRoles = accountWide(ctx, 'iam', 'role/lab-*');
  const lambdas = regional(ctx, 'lambda', 'function:lab-*');
  const tables = regional(ctx, 'dynamodb', 'table/lab-*');
  const logGroups = regional(ctx, 'logs', 'log-group:lab-*');
  const spans = regional(ctx, 'logs', 'log-group:aws/spans');
  const codeDeploy = (resource: string) => regional(ctx, 'codedeploy', resource);
  const parameters = regional(ctx, 'ssm', 'parameter/lab/*');
  const bootstrapVersion = regional(ctx, 'ssm', `parameter/cdk-bootstrap/${BOOTSTRAP_QUALIFIER}/version`);
  const assets = `arn:${partition}:s3:::cdk-${BOOTSTRAP_QUALIFIER}-assets-${account}-${region}/*`;
  const apiGateway = (resource: string) => `arn:${partition}:apigateway:${region}::${resource}`;
  const managedPolicy = (name: string) => `arn:${partition}:iam::aws:policy/service-role/${name}`;

  return {
    Version: '2012-10-17',
    Statement: [
      {
        // These actions list or describe, or they have no resource level. They show names and settings, no data.
        Effect: 'Allow',
        Action: [
          'appconfig:List*',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:ListDashboards',
          'codedeploy:GetDeployment',
          'codedeploy:List*',
          'dynamodb:ListTables',
          'iam:ListRoles',
          'lambda:ListFunctions',
          'logs:DescribeLogGroups',
          'logs:DescribeResourcePolicies',
          'ssm:DescribeParameters',
        ],
        Resource: '*',
      },
      {
        // Transaction Search: a resource policy for X-Ray, and the destination of the spans.
        Effect: 'Allow',
        Action: [
          'logs:PutResourcePolicy',
          'logs:DeleteResourcePolicy',
          'xray:GetIndexingRules',
          'xray:GetTraceSegmentDestination',
          'xray:UpdateIndexingRule',
          'xray:UpdateTraceSegmentDestination',
        ],
        Resource: '*',
      },
      {
        Effect: 'Allow',
        Action: [
          'apigateway:GET',
          'apigateway:POST',
          'apigateway:PUT',
          'apigateway:PATCH',
          'apigateway:DELETE',
          // The handler of the stage tags it with these two names.
          'apigateway:TagResource',
          'apigateway:UntagResource',
        ],
        Resource: [apiGateway('/apis'), apiGateway('/apis/*'), apiGateway('/tags/*')],
      },
      {
        Effect: 'Allow',
        Action: [
          'appconfig:Create*',
          'appconfig:Delete*',
          'appconfig:Get*',
          'appconfig:Update*',
          'appconfig:StartDeployment',
          'appconfig:StopDeployment',
          'appconfig:TagResource',
          'appconfig:UntagResource',
        ],
        Resource: regional(ctx, 'appconfig', '*'),
      },
      {
        Effect: 'Allow',
        Action: [
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DeleteAlarms',
          'cloudwatch:PutDashboard',
          'cloudwatch:DeleteDashboards',
          'cloudwatch:GetDashboard',
          'cloudwatch:TagResource',
          'cloudwatch:UntagResource',
          'cloudwatch:ListTagsForResource',
        ],
        Resource: [regional(ctx, 'cloudwatch', 'alarm:lab-*'), accountWide(ctx, 'cloudwatch', 'dashboard/lab-*')],
      },
      {
        Effect: 'Allow',
        Action: [
          'codedeploy:CreateApplication',
          'codedeploy:DeleteApplication',
          'codedeploy:CreateDeploymentGroup',
          'codedeploy:UpdateDeploymentGroup',
          'codedeploy:DeleteDeploymentGroup',
          'codedeploy:CreateDeployment',
          'codedeploy:StopDeployment',
          'codedeploy:RegisterApplicationRevision',
          'codedeploy:Get*',
          'codedeploy:TagResource',
          'codedeploy:UntagResource',
        ],
        Resource: [codeDeploy('application:lab-*'), codeDeploy('deploymentgroup:lab-*/*'), codeDeploy('deploymentconfig:*')],
      },
      {
        Effect: 'Allow',
        Action: [
          'dynamodb:CreateTable',
          'dynamodb:DeleteTable',
          'dynamodb:UpdateTable',
          'dynamodb:Describe*',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:UpdateTimeToLive',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:ListTagsOfResource',
        ],
        Resource: [tables, `${tables}/*`],
      },
      {
        Effect: 'Allow',
        Action: [
          'lambda:CreateFunction',
          'lambda:DeleteFunction',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
          'lambda:CreateAlias',
          'lambda:UpdateAlias',
          'lambda:DeleteAlias',
          'lambda:RemovePermission',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:PutFunctionConcurrency',
          'lambda:DeleteFunctionConcurrency',
          'lambda:PutRuntimeManagementConfig',
          'lambda:Get*',
          'lambda:List*',
          // CloudFormation calls the function of a custom resource.
          'lambda:InvokeFunction',
        ],
        Resource: lambdas,
      },
      {
        // A function may be open to API Gateway and to no other caller. This keeps a function URL or a public function out.
        Effect: 'Allow',
        Action: ['lambda:AddPermission'],
        Resource: lambdas,
        Condition: { StringEquals: { 'lambda:Principal': 'apigateway.amazonaws.com' } },
      },
      {
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:DeleteLogGroup',
          'logs:PutRetentionPolicy',
          'logs:DeleteRetentionPolicy',
          // Tag, untag and list tags, with the old and the new action names.
          'logs:*Tag*',
          'logs:Describe*',
          'logs:Get*',
        ],
        Resource: [logGroups, `${logGroups}:*`, spans, `${spans}:*`],
      },
      {
        Effect: 'Allow',
        Action: [
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:AddTagsToResource',
          'ssm:RemoveTagsFromResource',
          'ssm:ListTagsForResource',
        ],
        Resource: [parameters, bootstrapVersion],
      },
      {
        // Lambda reads the zip of a function from the asset bucket of the bootstrap.
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: assets,
      },
      {
        // IAM: a role is born with the boundary, and keeps it. These actions can add permission to a role.
        Effect: 'Allow',
        Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy', 'iam:UpdateAssumeRolePolicy'],
        Resource: labRoles,
        Condition: { StringEquals: { 'iam:PermissionsBoundary': boundary } },
      },
      {
        Effect: 'Allow',
        Action: ['iam:AttachRolePolicy'],
        Resource: labRoles,
        Condition: {
          StringEquals: {
            'iam:PermissionsBoundary': boundary,
            'iam:PolicyARN': [managedPolicy('AWSLambdaBasicExecutionRole'), managedPolicy('AWSCodeDeployRoleForLambdaLimited')],
          },
        },
      },
      {
        // These actions never add permission, so a role without the boundary can still be cleaned up.
        Effect: 'Allow',
        Action: [
          'iam:Get*',
          'iam:List*',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:UpdateRole',
          'iam:UpdateRoleDescription',
          'iam:DeleteRolePolicy',
          'iam:DetachRolePolicy',
          'iam:DeleteRole',
        ],
        Resource: labRoles,
      },
      {
        Effect: 'Allow',
        Action: ['iam:PassRole'],
        Resource: labRoles,
        Condition: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'codedeploy.amazonaws.com'] } },
      },
      {
        // The guard cannot change itself, and a stack cannot touch the identities of the platform.
        Sid: 'NeverTouchTheGuardOrTheIdentities',
        Effect: 'Deny',
        Action: ['iam:*'],
        Resource: [
          accountWide(ctx, 'iam', 'role/github-*'),
          accountWide(ctx, 'iam', `role/cdk-${BOOTSTRAP_QUALIFIER}-*`),
          accountWide(ctx, 'iam', 'role/aws-reserved/*'),
          accountWide(ctx, 'iam', 'role/aws-service-role/*'),
          accountWide(ctx, 'iam', 'role/OrganizationAccountAccessRole'),
          boundary,
          executionPolicyArn(ctx),
          accountWide(ctx, 'iam', 'oidc-provider/*'),
          accountWide(ctx, 'iam', 'saml-provider/*'),
          accountWide(ctx, 'iam', 'user/*'),
          accountWide(ctx, 'iam', 'group/*'),
        ],
      },
      {
        // Every service is regional, so a template cannot build in another region. IAM is global.
        Sid: 'OneRegionOnly',
        Effect: 'Deny',
        NotAction: ['iam:*'],
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:RequestedRegion': region } },
      },
    ],
  };
}
