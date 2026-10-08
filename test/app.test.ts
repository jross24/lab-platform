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

  it('makes only the platform stack for dev', () => {
    expect(stackNames('dev')).toEqual(['lab-platform-dev']);
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
