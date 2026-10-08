import { Aws, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnResourcePolicy } from 'aws-cdk-lib/aws-logs';
import { CfnTransactionSearchConfig } from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';

// Turns on CloudWatch Transaction Search in the account and the region of the stack.
//
// The OTLP endpoint of X-Ray accepts spans only when Transaction Search is on. Then X-Ray writes each span
// as a log event into the log group aws/spans, and it indexes a part of the spans as traces that
// `aws xray batch-get-traces` and the X-Ray console can find.
//
// The setting belongs to the whole account. All four services send spans to the same endpoint, so it
// belongs to the platform stack and not to one service (lab-platform#27). Before that, core owned it.
//
// Both resources have a fixed identity in the account (the policy name, and the account for the configuration).
// So the stack keeps them when it goes away: a delete of the configuration switches tracing off for all services.
export class TransactionSearch extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // X-Ray needs the permission to write into the log group. A resource policy of CloudWatch Logs gives it.
    // The policy names this account and this region only, so another account cannot make X-Ray write here.
    const policy = new CfnResourcePolicy(this, 'XRayCanWriteSpans', {
      policyName: 'lab-xray-can-write-spans',
      policyDocument: Stack.of(this).toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: { Service: 'xray.amazonaws.com' },
            Action: 'logs:PutLogEvents',
            Resource: [
              `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:aws/spans:*`,
              `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/application-signals/data:*`,
            ],
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:xray:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
              StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
            },
          },
        ],
      }),
    });
    policy.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // 100 percent of the spans become traces that the X-Ray API can find. The lab has little traffic.
    // A real team lowers this value: AWS indexes 1 percent for free and charges for the rest.
    const config = new CfnTransactionSearchConfig(this, 'Config', { indexingPercentage: 100 });
    config.applyRemovalPolicy(RemovalPolicy.RETAIN);
    config.addDependency(policy);
  }
}
