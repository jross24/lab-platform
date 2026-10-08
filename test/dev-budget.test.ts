import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DevGuardrailsStack } from '../lib/dev-guardrails-stack.ts';

const config = { environment: 'dev', githubOwner: 'jross24', githubOwnerId: '1001', workflowRef: 'refs/heads/main' } as const;
const stack = new DevGuardrailsStack(new App(), config);
const template = Template.fromStack(stack);

interface Statement {
  Effect: string;
  Principal?: unknown;
  Action?: string | string[];
  Resource?: unknown;
  Condition?: { StringEquals?: unknown; ArnLike?: unknown; Bool?: unknown };
}

interface Resource {
  Type: string;
  DependsOn?: string | string[];
  Properties: {
    Budget: { CostTypes?: unknown; [key: string]: unknown };
    NotificationsWithSubscribers: Array<{ Notification: Record<string, unknown>; Subscribers: unknown[] }>;
    TopicName?: string;
    KmsMasterKeyId?: unknown;
    Topics?: unknown;
    PolicyDocument: { Statement: Statement[] };
  };
}

function resourcesOf(type: string): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as Array<[string, Resource]>;
}

function onlyResource(type: string): [string, Resource] {
  const found = resourcesOf(type);
  expect(found, type).toHaveLength(1);
  return found[0] as [string, Resource];
}

describe('the budget of the dev account', () => {
  const [, budget] = onlyResource('AWS::Budgets::Budget');
  const [topicId, topic] = onlyResource('AWS::SNS::Topic');

  it('is one monthly cost budget of 2 USD', () => {
    expect(budget.Properties.Budget).toMatchObject({
      BudgetName: 'lab-dev-monthly',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 2, Unit: 'USD' },
    });
  });

  it('counts the usage and not the credits, so a credit does not hide the spend', () => {
    expect(budget.Properties.Budget.CostTypes).toMatchObject({ IncludeCredit: false, IncludeRefund: false });
  });

  it('notifies at 80 percent of the actual cost and at 100 percent of the forecast, and at no other point', () => {
    const notifications = budget.Properties.NotificationsWithSubscribers.map((entry) => entry.Notification);
    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(
      expect.arrayContaining([
        { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' },
        { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' },
      ]),
    );
  });

  it('sends each notification to the topic of the stack, and to nothing else', () => {
    for (const entry of budget.Properties.NotificationsWithSubscribers) {
      expect(entry.Subscribers).toEqual([{ SubscriptionType: 'SNS', Address: { Ref: topicId } }]);
    }
  });

  it('has no action, so it warns and does not stop anything', () => {
    template.resourceCountIs('AWS::Budgets::BudgetsAction', 0);
  });

  it('writes the topic with a fixed name, so the command of the owner can name it', () => {
    expect(topic.Properties.TopicName).toBe('lab-dev-budget-alerts');
  });

  it('leaves the topic unencrypted, because a key of the default kind would stop Budgets from publishing', () => {
    expect(topic.Properties.KmsMasterKeyId).toBeUndefined();
  });

  it('has no subscription and no email address', () => {
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/@|mailto|"email"/i);
  });

  it('has no account ID in it', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
  });
});

describe('the topic policy of the budget', () => {
  const [topicId] = onlyResource('AWS::SNS::Topic');
  const [policyId, policy] = onlyResource('AWS::SNS::TopicPolicy');
  const statements = policy.Properties.PolicyDocument.Statement;
  const allows = statements.filter((statement) => statement.Effect === 'Allow');

  it('belongs to the topic', () => {
    expect(policy.Properties.Topics).toEqual([{ Ref: topicId }]);
  });

  it('lets budgets.amazonaws.com publish to the topic, and lets no other principal do anything', () => {
    expect(allows).toHaveLength(1);
    const [allow] = allows;
    expect(allow?.Principal).toEqual({ Service: 'budgets.amazonaws.com' });
    expect([allow?.Action].flat()).toEqual(['sns:Publish']);
    expect(allow?.Resource).toEqual({ Ref: topicId });
  });

  it('accepts only a budget of the same account', () => {
    const condition = allows[0]?.Condition;
    expect(condition?.StringEquals).toEqual({ 'aws:SourceAccount': { Ref: 'AWS::AccountId' } });
    expect(JSON.stringify(condition?.ArnLike)).toContain('budgets::');
    expect(JSON.stringify(condition?.ArnLike)).toContain('AWS::AccountId');
  });

  it('refuses a request that does not use TLS', () => {
    const deny = statements.find((statement) => statement.Effect === 'Deny');
    expect(deny?.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
  });

  it('exists before the budget, because Budgets checks the policy when it makes the budget', () => {
    const [, budget] = onlyResource('AWS::Budgets::Budget');
    expect([budget.DependsOn ?? []].flat()).toContain(policyId);
  });
});

describe('the guardrails stack with the budget', () => {
  it('holds the two policies, the topic, its policy and the budget, and nothing else', () => {
    const types = Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((resource) => resource.Type);
    expect(types.sort()).toEqual([
      'AWS::Budgets::Budget',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::ManagedPolicy',
      'AWS::SNS::Topic',
      'AWS::SNS::TopicPolicy',
    ]);
  });

  it('tags the topic and the budget as the guardrails stack tags its other resources', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'lab-managed-by', Value: 'lab-platform' }]),
    });
    template.hasResourceProperties('AWS::Budgets::Budget', {
      ResourceTags: Match.arrayWith([{ Key: 'lab-managed-by', Value: 'lab-platform' }]),
    });
  });
});
