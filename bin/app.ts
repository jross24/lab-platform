import { App } from 'aws-cdk-lib';
import { readConfig } from '../lib/config.ts';
import { PlatformStack } from '../lib/platform-stack.ts';

const app = new App();
new PlatformStack(app, readConfig(app));
