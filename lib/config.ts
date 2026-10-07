import type { App } from 'aws-cdk-lib';

const ENVIRONMENTS = ['test', 'staging', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export interface Config {
  readonly environment: Environment;
  readonly githubOwner: string;
  readonly githubOwnerId: string;
}

// The owner goes into the trust policy of the role. A wildcard there would let other owners in.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// GitHub puts the numeric owner ID in the sub claim, so a new owner of an old name does not match.
const GITHUB_OWNER_ID = /^[0-9]+$/;

function isEnvironment(value: unknown): value is Environment {
  return ENVIRONMENTS.some((environment) => environment === value);
}

export function readConfig(app: App): Config {
  const environment: unknown = app.node.tryGetContext('environment');
  if (!isEnvironment(environment)) {
    throw new Error(
      `Context value environment must be one of ${ENVIRONMENTS.join(', ')}. ` +
        `Got ${JSON.stringify(environment)}. Example: -c environment=test`,
    );
  }

  const githubOwner: unknown = app.node.tryGetContext('githubOwner');
  if (typeof githubOwner !== 'string' || !GITHUB_OWNER.test(githubOwner)) {
    throw new Error(
      'Context value githubOwner must be a GitHub user or organisation name. ' +
        `Got ${JSON.stringify(githubOwner)}. Example: -c githubOwner=my-org`,
    );
  }

  const githubOwnerId: unknown = app.node.tryGetContext('githubOwnerId');
  // A numeric context value arrives as a number when it comes from cdk.json.
  const ownerId = typeof githubOwnerId === 'number' ? String(githubOwnerId) : githubOwnerId;
  if (typeof ownerId !== 'string' || !GITHUB_OWNER_ID.test(ownerId)) {
    throw new Error(
      'Context value githubOwnerId must be the numeric ID of the GitHub owner. ' +
        `Got ${JSON.stringify(githubOwnerId)}. Find it with: gh api users/<owner> --jq .id`,
    );
  }

  return { environment, githubOwner, githubOwnerId: ownerId };
}
