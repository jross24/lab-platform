import { App } from 'aws-cdk-lib';
import { readConfig } from './config.ts';
import { PlatformRootStack } from './root-stack.ts';
import { PlatformStack } from './platform-stack.ts';

// Context values: environment, githubOwner and githubOwnerId.
export function createApp(context?: Record<string, unknown>): App {
  const app = new App({ context });
  const config = readConfig(app);
  const platform = new PlatformStack(app, config);

  // The dev account has no pipeline, so it has no pipeline role.
  if (config.environment !== 'dev') {
    new PlatformRootStack(app, config).addStackDependency(platform);
  }
  return app;
}
