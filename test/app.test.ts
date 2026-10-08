import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app.ts';

function stackNames(environment: string): string[] {
  const app = createApp({ environment, githubOwner: 'jross24', githubOwnerId: '1001' });
  return app.synth().stacks.map((stack) => stack.stackName).sort();
}

// The first synthesis of a full app can take more than 5 seconds when test files run in parallel.
describe('createApp', { timeout: 30_000 }, () => {
  it.each(['test', 'staging', 'production'])('makes the platform stack and the root stack for %s', (environment) => {
    expect(stackNames(environment)).toEqual([`lab-platform-${environment}`, `lab-platform-root-${environment}`].sort());
  });

  it('makes the platform stack and the guardrails stack for dev, and no root stack', () => {
    expect(stackNames('dev')).toEqual(['lab-platform-dev', 'lab-platform-dev-guardrails']);
  });

  it('deploys the dev stacks with the credentials of the person, so the execution policy of dev cannot block them', () => {
    const assembly = createApp({ environment: 'dev', githubOwner: 'jross24', githubOwnerId: '1001' }).synth();
    for (const name of ['lab-platform-dev', 'lab-platform-dev-guardrails']) {
      const stack = assembly.getStackByName(name);
      expect(stack.cloudFormationExecutionRoleArn, name).toBeUndefined();
      expect(stack.assumeRoleArn, name).toBeUndefined();
    }
  });

  it.each(['test', 'staging', 'production'])('deploys the stacks of %s through the bootstrap roles', (environment) => {
    const assembly = createApp({ environment, githubOwner: 'jross24', githubOwnerId: '1001' }).synth();
    for (const stack of assembly.stacks) {
      expect(stack.cloudFormationExecutionRoleArn, stack.stackName).toMatch(/cfn-exec-role/);
    }
  });

  it('makes the root stack depend on the platform stack, so the OIDC provider exists first', () => {
    const app = createApp({ environment: 'test', githubOwner: 'jross24', githubOwnerId: '1001' });
    const root = app.synth().getStackByName('lab-platform-root-test');
    // The other dependency is the asset manifest of the root stack itself.
    expect(root.dependencies.map((dependency) => dependency.id).filter((id) => !id.endsWith('.assets'))).toEqual(['Platform']);
  });

  it('rejects a missing environment', () => {
    expect(() => createApp({ githubOwner: 'jross24', githubOwnerId: '1001' })).toThrow(/environment must be one of/);
  });
});
