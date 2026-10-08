// Imports the Transaction Search resources into the stack Platform when they exist in the account and the stack lacks them.
// The deploy action runs this before `cdk deploy`. See the README, section "Take over a setting that exists already".
//
//   node scripts/import-missing.ts [--dry-run]
//
// Settings (environment variables):
//   ENVIRONMENT  test, staging, production or dev
//   OWNER        the GitHub owner of the repositories (context githubOwner)
//   OWNER_ID     the numeric ID of the owner (context githubOwnerId)
//   AWS_REGION   the region of the stack
//   AWS_CLI      the AWS CLI command. Default: aws
// The credentials come from the environment, as for `aws` and `cdk`.
//
// The step reads the stack through the CDK deploy role of the account. The role of the pipeline can assume that role
// and nothing else, so the step needs no new permission. The pipeline role cannot read CloudWatch Logs or X-Ray, and it
// must not get that permission. So the step cannot ask the account if the resources exist. It asks the stack, and
// CloudFormation checks the account when it makes the IMPORT change set: it refuses a resource that does not exist.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOTSTRAP_QUALIFIER } from '../lib/github.ts';
import { decide, fillMapping, importFailureKind, listedLogicalIds, missingResources, restrictMapping } from './import-plan.ts';

const MAPPING_FILE = new URL('../import/transaction-search.json', import.meta.url);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The environment variable ${name} is not set.`);
  return value;
}

const cli = process.env.AWS_CLI ?? 'aws';

function aws(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(cli, [...args, '--output', 'json'], { encoding: 'utf8', env });
}

function awsJson(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = aws(args, env);
  if (result.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const environment = need('ENVIRONMENT');
  const owner = need('OWNER');
  const ownerId = need('OWNER_ID');
  const region = need('AWS_REGION');
  const stackName = `lab-platform-${environment}`;

  const accountId = (JSON.parse(awsJson(['sts', 'get-caller-identity'])) as { Account: string }).Account;
  const mapping = fillMapping(readFileSync(MAPPING_FILE, 'utf8'), accountId);

  // The pipeline role holds no read permission. The deploy role of CDK holds CloudFormation read access.
  const roleArn = `arn:aws:iam::${accountId}:role/cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-${accountId}-${region}`;
  const assumed = JSON.parse(
    awsJson(['sts', 'assume-role', '--role-arn', roleArn, '--role-session-name', 'platform-import-check']),
  ) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } };
  const readEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: assumed.Credentials.SessionToken,
  };
  delete readEnv.AWS_PROFILE;

  const listing = aws(['cloudformation', 'list-stack-resources', '--stack-name', stackName], readEnv);
  let stackExists = true;
  let listed: string[] = [];
  if (listing.status === 0) {
    listed = listedLogicalIds(listing.stdout);
  } else if (/does not exist/.test(listing.stderr)) {
    stackExists = false;
  } else {
    throw new Error(`Cannot read the stack ${stackName}: ${listing.stderr.trim()}`);
  }

  const missing = missingResources(Object.keys(mapping), listed);
  const decision = decide({ stackExists, missing });
  console.log(`Import step for ${stackName}: ${decision.action}${decision.toImport.length ? ` (${decision.toImport.join(', ')})` : ''}`);

  if (decision.action !== 'import') return;
  if (dryRun) {
    console.log('Dry run: no import.');
    return;
  }

  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'import-'));
  const mappingPath = join(dir, 'mapping.json');
  writeFileSync(mappingPath, JSON.stringify(restrictMapping(mapping, decision.toImport)));

  // No --force: CDK then refuses an import when the stack has other changes.
  // The output goes to the log and is also kept, to tell "the resource does not exist" from a real failure.
  const result = spawnSync(
    'npx',
    [
      'cdk', 'import', 'Platform',
      '-c', `environment=${environment}`,
      '-c', `githubOwner=${owner}`,
      '-c', `githubOwnerId=${ownerId}`,
      '--resource-mapping', mappingPath,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env, shell: process.platform === 'win32' },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status === 0) return;

  if (importFailureKind(`${result.stdout}
${result.stderr}`) === 'not-found') {
    console.log(
      `::notice::CloudFormation did not find the resources in the account, so there is nothing to import. The deployment creates them.`,
    );
    return;
  }
  throw new Error(
    `cdk import failed for ${stackName}. Read the log above. A likely cause is that the stack has other changes: an import cannot change other resources.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
