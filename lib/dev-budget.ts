import { Aws } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export const BUDGET_NAME = 'lab-dev-monthly';
export const TOPIC_NAME = 'lab-dev-budget-alerts';
export const BUDGET_LIMIT_USD = 2;

export interface DevBudgetProps {
  // Tags for the budget. CloudFormation tags the topic through the stack, but not the budget.
  readonly tags: Record<string, string>;
}

// A monthly cost budget for the dev account, and the SNS topic that it publishes to.
//
// A budget warns. It does not stop spend. The topic has no subscriber and the code holds no address: the owner adds
// a subscription by hand (see the README), so no email address is in this public repository.
export class DevBudget extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: DevBudgetProps) {
    super(scope, id);

    // The topic stays unencrypted. Budgets cannot publish to a topic that uses the AWS managed key of SNS, and a key of
    // the lab would add a cost and a key policy for an alert that holds only a cost figure.
    this.topic = new sns.Topic(this, 'Topic', {
      topicName: TOPIC_NAME,
      displayName: 'lab-dev budget',
      enforceSSL: true,
    });

    // Budgets checks this permission when it makes the budget. The conditions stop another account, or a budget of
    // another account, from using the topic through the service principal.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSBudgetsSNSPublishingPermissions',
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:budgets::${Aws.ACCOUNT_ID}:*` },
        },
      }),
    );

    const subscribers = [{ subscriptionType: 'SNS', address: this.topic.topicArn }];

    const budget = new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: BUDGET_NAME,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: BUDGET_LIMIT_USD, unit: 'USD' },
        // Count the usage and not the credits. A credit would otherwise hide the spend until the credit ends.
        costTypes: { includeCredit: false, includeRefund: false },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
      ],
      resourceTags: Object.entries(props.tags).map(([key, value]) => ({ key, value })),
    });
    // The whole topic: the topic and its policy must exist before the budget.
    budget.node.addDependency(this.topic);
  }
}
