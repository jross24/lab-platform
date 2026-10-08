import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { readConfig } from '../lib/config.ts';

function appWith(context: Record<string, unknown>): App {
  return new App({ context });
}

describe('readConfig', () => {
  it.each(['test', 'staging', 'production', 'dev'])('accepts environment %s', (environment) => {
    const config = readConfig(appWith({ environment, githubOwner: 'jross24', githubOwnerId: '1001' }));
    expect(config).toEqual({
      environment,
      githubOwner: 'jross24',
      githubOwnerId: '1001',
      workflowRef: 'refs/heads/main',
    });
  });

  it.each(['prod', 'Test', 'Dev', '', '*'])('rejects invalid environment "%s"', (environment) => {
    expect(() => readConfig(appWith({ environment, githubOwner: 'jross24', githubOwnerId: '1001' }))).toThrow(
      /environment must be one of test, staging, production, dev/,
    );
  });

  it('rejects a missing environment', () => {
    expect(() => readConfig(appWith({ githubOwner: 'jross24', githubOwnerId: '1001' }))).toThrow(
      /environment must be one of test, staging, production, dev/,
    );
  });

  it('rejects a missing githubOwner', () => {
    expect(() => readConfig(appWith({ environment: 'test' }))).toThrow(/githubOwner/);
  });

  it.each(['*', 'jross24/*', 'a b', '-lead'])('rejects githubOwner "%s"', (githubOwner) => {
    expect(() => readConfig(appWith({ environment: 'test', githubOwner, githubOwnerId: '1001' }))).toThrow(/githubOwner/);
  });

  it('rejects a missing githubOwnerId', () => {
    expect(() => readConfig(appWith({ environment: 'test', githubOwner: 'jross24' }))).toThrow(
      /githubOwnerId/,
    );
  });

  it.each(['*', '12a', '', '1001/*'])('rejects githubOwnerId "%s"', (githubOwnerId) => {
    expect(() =>
      readConfig(appWith({ environment: 'test', githubOwner: 'jross24', githubOwnerId })),
    ).toThrow(/githubOwnerId/);
  });

  describe('workflowRef', () => {
    const base = { githubOwner: 'jross24', githubOwnerId: '1001' };

    it('defaults to main', () => {
      expect(readConfig(appWith({ ...base, environment: 'dev' })).workflowRef).toBe('refs/heads/main');
    });

    it('lets the dev account follow a branch while a workflow is under development', () => {
      const config = readConfig(appWith({ ...base, environment: 'dev', workflowRef: 'refs/heads/feat/*' }));
      expect(config.workflowRef).toBe('refs/heads/feat/*');
    });

    it.each(['test', 'staging', 'production'])('rejects another ref in %s, where the trust must stay on main', (environment) => {
      expect(() => readConfig(appWith({ ...base, environment, workflowRef: 'refs/heads/feat/*' }))).toThrow(
        /workflowRef can differ from refs\/heads\/main only in the dev account/,
      );
    });

    it('accepts the default value in every account', () => {
      expect(readConfig(appWith({ ...base, environment: 'production', workflowRef: 'refs/heads/main' })).workflowRef).toBe(
        'refs/heads/main',
      );
    });

    it.each(['main', 'refs/tags/v1', 'refs/heads/', 'refs/heads/a b', 'refs/heads/x;y', '*', ''])(
      'rejects the malformed ref %j',
      (workflowRef) => {
        expect(() => readConfig(appWith({ ...base, environment: 'dev', workflowRef }))).toThrow(/workflowRef/);
      },
    );
  });
});
