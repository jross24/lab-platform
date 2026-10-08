import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack.ts';
import {
  ACCOUNT_ID_PLACEHOLDER,
  decide,
  fillMapping,
  listedLogicalIds,
  missingResources,
  restrictMapping,
} from '../scripts/import-plan.ts';

const MAPPING_FILE = new URL('../import/transaction-search.json', import.meta.url);
const mappingText = readFileSync(MAPPING_FILE, 'utf8');
const mappingIds = Object.keys(JSON.parse(mappingText) as object).sort();

describe('decide', () => {
  it('does nothing when the stack holds every resource', () => {
    expect(decide({ stackExists: true, missing: [] })).toEqual({ action: 'nothing', toImport: [] });
  });

  it('lets the deployment create everything when the stack does not exist yet', () => {
    expect(decide({ stackExists: false, missing: ['A', 'B'] })).toEqual({ action: 'create', toImport: [] });
  });

  it('imports both resources when the stack exists and holds neither', () => {
    expect(decide({ stackExists: true, missing: ['A', 'B'] })).toEqual({ action: 'import', toImport: ['A', 'B'] });
  });

  it('imports only the resource that the stack lacks', () => {
    expect(decide({ stackExists: true, missing: ['B'] })).toEqual({ action: 'import', toImport: ['B'] });
  });

  it('does not touch the input', () => {
    const missing = ['A'];
    decide({ stackExists: true, missing });
    expect(missing).toEqual(['A']);
  });
});

describe('missingResources', () => {
  it('lists the mapped resources that the stack does not list', () => {
    expect(missingResources(['A', 'B', 'C'], ['B'])).toEqual(['A', 'C']);
  });

  it('lists nothing when the stack holds all of them', () => {
    expect(missingResources(['A', 'B'], ['B', 'A', 'Other'])).toEqual([]);
  });
});

describe('listedLogicalIds', () => {
  it('reads the logical IDs of a list-stack-resources answer', () => {
    const answer = JSON.stringify({
      StackResourceSummaries: [
        { LogicalResourceId: 'A', ResourceType: 'AWS::X::Y' },
        { LogicalResourceId: 'B', ResourceType: 'AWS::X::Z' },
      ],
    });
    expect(listedLogicalIds(answer)).toEqual(['A', 'B']);
  });

  it('accepts an answer with no resources', () => {
    expect(listedLogicalIds('{}')).toEqual([]);
  });
});

describe('fillMapping', () => {
  it('puts the account ID in place of the placeholder', () => {
    const mapping = fillMapping(`{"X":{"AccountId":"${ACCOUNT_ID_PLACEHOLDER}"}}`, '123456789012');
    expect(mapping).toEqual({ X: { AccountId: '123456789012' } });
  });

  it('rejects an account ID that is not 12 digits', () => {
    expect(() => fillMapping(`{"X":{"AccountId":"${ACCOUNT_ID_PLACEHOLDER}"}}`, 'abc')).toThrow(/account/i);
  });

  it('rejects a placeholder that it does not know', () => {
    expect(() => fillMapping('{"X":{"AccountId":"{{other}}"}}', '123456789012')).toThrow(/{{other}}/);
  });
});

describe('restrictMapping', () => {
  it('keeps only the resources to import', () => {
    expect(restrictMapping({ A: { N: '1' }, B: { N: '2' } }, ['B'])).toEqual({ B: { N: '2' } });
  });

  it('fails when a resource has no mapping, because an import cannot guess an identifier', () => {
    expect(() => restrictMapping({ A: { N: '1' } }, ['A', 'B'])).toThrow(/B/);
  });
});

describe('the mapping file of the repository', () => {
  it('holds no account ID, only the placeholder', () => {
    expect(mappingText).not.toMatch(/[0-9]{12}/);
    expect(mappingText).toContain(ACCOUNT_ID_PLACEHOLDER);
  });

  describe.each(['test', 'staging', 'production', 'dev'] as const)('the stack in %s', (environment) => {
    // The synthesis runs once, when the suite is collected, so it does not count against the time limit of a test.
    const template = Template.fromStack(
      new PlatformStack(new App(), {
        environment,
        githubOwner: 'jross24',
        githubOwnerId: '1001',
        workflowRef: 'refs/heads/main',
      }),
    );

    it('has exactly the Transaction Search resources that the mapping file names', () => {
      const ids = [
        ...Object.keys(template.findResources('AWS::Logs::ResourcePolicy')),
        ...Object.keys(template.findResources('AWS::XRay::TransactionSearchConfig')),
      ].sort();
      expect(mappingIds).toEqual(ids);
    });
  });

  it('uses the identifier property that CloudFormation needs for each type', () => {
    const mapping = JSON.parse(mappingText) as Record<string, Record<string, string>>;
    const keys = Object.values(mapping).map((v) => Object.keys(v)[0]);
    expect(keys.sort()).toEqual(['AccountId', 'PolicyName']);
  });
});
