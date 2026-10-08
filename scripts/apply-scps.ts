// Applies the service control policies of the lab from a laptop. See the README, section "Service control policies".
//
//   node scripts/apply-scps.ts apply  <policy> <target>... [--dry-run]
//   node scripts/apply-scps.ts remove <policy> <target>... [--delete] [--dry-run]
//   node scripts/apply-scps.ts status
//
// <policy> is lab-dev-guardrail or lab-pipeline-role-guard. <target> is dev, test, staging or production.
//
// The script reads the account IDs from an env file outside the repository. It needs the AWS CLI v2 and a profile of
// the management account. It uses only the `organizations` API. Settings (environment variables):
//   LAB_ACCOUNTS_ENV  path of the env file. Default: ~/repos/.lab-accounts.env
//   LAB_ADMIN_PROFILE AWS profile of the management account. Default: lab-admin
//   AWS_CLI           the AWS CLI command. Default: aws

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LAB_TARGETS,
  POLICIES,
  applyPolicy,
  labAccounts,
  loadPolicy,
  parseEnv,
  policySpec,
  removePolicy,
  resolveTargets,
  statusOf,
  type Aws,
} from './scp.ts';

const USAGE = `usage:
  node scripts/apply-scps.ts apply  <policy> <target>... [--dry-run]
  node scripts/apply-scps.ts remove <policy> <target>... [--delete] [--dry-run]
  node scripts/apply-scps.ts status
policy: ${POLICIES.map((p) => p.name).join(' | ')}
target: ${LAB_TARGETS.join(' | ')}`;

function main(argv: string[]): void {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const [command, policyName, ...names] = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = [...flags].filter((flag) => !['--dry-run', '--delete'].includes(flag));
  if (unknown.length > 0 || !command || !['apply', 'remove', 'status'].includes(command)) {
    throw new Error(`${unknown.length > 0 ? `unknown flag ${unknown.join(' ')}\n` : ''}${USAGE}`);
  }
  if (flags.has('--delete') && command !== 'remove') throw new Error('--delete works only with remove');

  const envPath = process.env.LAB_ACCOUNTS_ENV ?? join(homedir(), 'repos', '.lab-accounts.env');
  const accounts = labAccounts(parseEnv(readFileSync(envPath, 'utf8')));
  const profile = process.env.LAB_ADMIN_PROFILE ?? 'lab-admin';
  const cli = process.env.AWS_CLI ?? 'aws';

  const aws: Aws = (args) =>
    execFileSync(cli, [...args, '--profile', profile, '--region', 'us-east-1', '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  const log = (message: string) => console.log(message);
  const dryRun = flags.has('--dry-run');
  const root = new URL('../', import.meta.url);

  if (command === 'status') {
    for (const spec of POLICIES) {
      const targets = resolveTargets(accounts, spec, spec.targets);
      for (const line of statusOf({ aws, log, accounts, spec, dryRun }, targets)) log(line);
    }
    return;
  }

  if (!policyName) throw new Error(USAGE);
  const spec = policySpec(policyName);
  const targets = resolveTargets(accounts, spec, names);
  if (dryRun) log('dry run: no write call');
  if (command === 'apply') {
    applyPolicy({ aws, log, accounts, spec, targets, dryRun, content: loadPolicy(spec, root) });
  } else {
    removePolicy({ aws, log, accounts, spec, targets, dryRun, deletePolicy: flags.has('--delete') });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
