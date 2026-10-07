import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { readConfig } from '../lib/config.ts';

function appWith(context: Record<string, unknown>): App {
  return new App({ context });
}

describe('readConfig', () => {
  it.each(['test', 'staging', 'production'])('accepts environment %s', (environment) => {
    const config = readConfig(appWith({ environment, githubOwner: 'jross24' }));
    expect(config).toEqual({ environment, githubOwner: 'jross24' });
  });

  it.each(['prod', 'Test', '', '*'])('rejects invalid environment "%s"', (environment) => {
    expect(() => readConfig(appWith({ environment, githubOwner: 'jross24' }))).toThrow(
      /environment must be one of test, staging, production/,
    );
  });

  it('rejects a missing environment', () => {
    expect(() => readConfig(appWith({ githubOwner: 'jross24' }))).toThrow(
      /environment must be one of test, staging, production/,
    );
  });

  it('rejects a missing githubOwner', () => {
    expect(() => readConfig(appWith({ environment: 'test' }))).toThrow(/githubOwner/);
  });

  it.each(['*', 'jross24/*', 'a b', '-lead'])('rejects githubOwner "%s"', (githubOwner) => {
    expect(() => readConfig(appWith({ environment: 'test', githubOwner }))).toThrow(/githubOwner/);
  });
});
