/**
 * Profile command group — manages named CLI profiles.
 *
 * Subcommands:
 *   profile add <name> [--url <apiUrl>] [--token <token>]
 *   profile list
 *   profile use <name>
 *   profile show [name]
 *   profile edit <name> --url <apiUrl>
 *   profile remove <name>
 *   profile whoami
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  createProfile,
  deleteProfile,
  getActiveProfile,
  getActiveProfileName,
  getProfile,
  listProfiles,
  setActiveProfile,
  updateProfile,
} from '../lib/profileManager.js';
import { deleteToken, redactToken, setToken, getToken as getTokenForProfile } from '../lib/credentialStore.js';
import { getCliConfig } from '../lib/config.js';

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage named CLI profiles (credentials and API URLs)');

  // -------------------------------------------------------------------------
  // profile add
  // -------------------------------------------------------------------------
  profile
    .command('add')
    .description('Create a new profile')
    .argument('<name>', 'Profile name (letters, digits, hyphens, underscores)')
    .option(
      '-u, --url <apiUrl>',
      'API base URL for this profile',
      getCliConfig().STELLAR_ALERTS_API_URL
    )
    .option('-t, --token <token>', 'API token to store for this profile')
    .action(
      async (
        name: string,
        options: { url: string; token?: string }
      ) => {
        try {
          const created = createProfile(name, options.url);
          console.log(chalk.green(`✅ Profile "${chalk.cyan(created.name)}" created.`));
          console.log(`   API URL : ${chalk.cyan(created.apiUrl)}`);

          if (options.token) {
            setToken(name, options.token);
            console.log(
              `   Token   : ${chalk.cyan(redactToken(options.token))} (stored securely)`
            );
          } else {
            console.log(
              chalk.yellow(
                `   ℹ️  No token stored yet. Run: stellar-alerts-cli profile token set ${name} <token>`
              )
            );
          }

          const active = getActiveProfileName();
          if (active === name) {
            console.log(chalk.gray(`   (auto-activated as this is the first profile)`));
          }
        } catch (err) {
          console.error(chalk.red(`❌ ${(err as Error).message}`));
          process.exit(1);
        }
      }
    );

  // -------------------------------------------------------------------------
  // profile list
  // -------------------------------------------------------------------------
  profile
    .command('list')
    .alias('ls')
    .description('List all profiles')
    .action(() => {
      const profiles = listProfiles();
      const activeName = getActiveProfileName();

      if (profiles.length === 0) {
        console.log(
          chalk.yellow(
            '📭 No profiles found. Create one with: stellar-alerts-cli profile add <name>'
          )
        );
        return;
      }

      console.log(chalk.blue(`\n👤 CLI Profiles (${profiles.length})\n`));
      console.log(chalk.gray('─'.repeat(80)));
      console.log(
        chalk.bold(
          '  ' +
            'Name'.padEnd(24) +
            'API URL'.padEnd(42) +
            'Created'
        )
      );
      console.log(chalk.gray('─'.repeat(80)));

      for (const p of profiles) {
        const isActive = p.name === activeName;
        const marker = isActive ? chalk.green('▶ ') : '  ';
        const name = isActive ? chalk.green(p.name.padEnd(24)) : p.name.padEnd(24);
        console.log(
          `${marker}${name}${p.apiUrl.padEnd(42)}${chalk.gray(
            new Date(p.createdAt).toLocaleDateString()
          )}`
        );
      }

      console.log(chalk.gray('─'.repeat(80)));
      if (activeName) {
        console.log(chalk.gray(`\nActive profile: ${chalk.green(activeName)}\n`));
      }
    });

  // -------------------------------------------------------------------------
  // profile use
  // -------------------------------------------------------------------------
  profile
    .command('use')
    .description('Switch to a profile (make it active)')
    .argument('<name>', 'Profile name to activate')
    .action((name: string) => {
      try {
        setActiveProfile(name);
        console.log(chalk.green(`✅ Switched to profile "${chalk.cyan(name)}".`));
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // profile show
  // -------------------------------------------------------------------------
  profile
    .command('show')
    .description('Show details of a profile (defaults to active profile)')
    .argument('[name]', 'Profile name (defaults to active)')
    .action((name?: string) => {
      try {
        const target = name ? getProfile(name) : getActiveProfile();
        if (!target) {
          const hint = name
            ? `Profile "${name}" does not exist.`
            : 'No active profile. Create one with: stellar-alerts-cli profile add <name>';
          console.error(chalk.red(`❌ ${hint}`));
          process.exit(1);
        }

        const activeName = getActiveProfileName();
        const isActive = target.name === activeName;

        console.log(chalk.blue(`\n👤 Profile: ${chalk.bold(target.name)}\n`));
        console.log(`  Active  : ${isActive ? chalk.green('yes') : chalk.gray('no')}`);
        console.log(`  API URL : ${chalk.cyan(target.apiUrl)}`);
        console.log(`  Created : ${chalk.gray(new Date(target.createdAt).toISOString())}`);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // profile edit
  // -------------------------------------------------------------------------
  profile
    .command('edit')
    .description('Update the API URL of an existing profile')
    .argument('<name>', 'Profile name to update')
    .requiredOption('-u, --url <apiUrl>', 'New API base URL')
    .action((name: string, options: { url: string }) => {
      try {
        const updated = updateProfile(name, options.url);
        console.log(chalk.green(`✅ Profile "${chalk.cyan(updated.name)}" updated.`));
        console.log(`   API URL : ${chalk.cyan(updated.apiUrl)}`);
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // profile remove
  // -------------------------------------------------------------------------
  profile
    .command('remove')
    .alias('rm')
    .description('Delete a profile and its stored token')
    .argument('<name>', 'Profile name to delete')
    .action((name: string) => {
      try {
        deleteProfile(name);
        console.log(
          chalk.green(
            `✅ Profile "${chalk.cyan(name)}" and its stored token have been deleted.`
          )
        );
        const newActive = getActiveProfileName();
        if (newActive) {
          console.log(chalk.gray(`   Active profile is now "${newActive}".`));
        } else {
          console.log(
            chalk.yellow(
              '   ⚠️  No active profile. Create one with: stellar-alerts-cli profile add <name>'
            )
          );
        }
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // profile whoami  — quick diagnostic
  // -------------------------------------------------------------------------
  profile
    .command('whoami')
    .description('Show the currently active profile and redacted token')
    .action(() => {
      const active = getActiveProfile();
      if (!active) {
        console.log(
          chalk.yellow(
            '⚠️  No active profile. Create one with: stellar-alerts-cli profile add <name>'
          )
        );
        return;
      }

      const token = getTokenForProfile(active.name);
      const envToken = process.env.STELLAR_ALERTS_API_KEY;

      console.log(chalk.blue('\n🔑 Active Profile\n'));
      console.log(`  Name    : ${chalk.cyan(active.name)}`);
      console.log(`  API URL : ${chalk.cyan(active.apiUrl)}`);

      if (token) {
        console.log(`  Token   : ${chalk.cyan(redactToken(token))} ${chalk.gray('(from profile store)')}`);
      } else if (envToken) {
        console.log(
          `  Token   : ${chalk.cyan(redactToken(envToken))} ${chalk.gray('(from STELLAR_ALERTS_API_KEY env var)')}`
        );
      } else {
        console.log(
          `  Token   : ${chalk.yellow('none')} ${chalk.gray('(run: profile token set <name> <token>)')}`
        );
      }
      console.log('');
    });

  // -------------------------------------------------------------------------
  // profile token  — sub-group for token management
  // -------------------------------------------------------------------------
  const token = profile
    .command('token')
    .description('Manage stored tokens for profiles');

  token
    .command('set')
    .description('Store (or replace) the token for a profile')
    .argument('<name>', 'Profile name')
    .argument('<token>', 'API token value')
    .action((name: string, tokenValue: string) => {
      try {
        if (!getProfile(name)) {
          console.error(chalk.red(`❌ Profile "${name}" does not exist.`));
          process.exit(1);
        }
        setToken(name, tokenValue);
        console.log(
          chalk.green(
            `✅ Token for profile "${chalk.cyan(name)}" stored: ${chalk.cyan(redactToken(tokenValue))}`
          )
        );
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });

  token
    .command('unset')
    .description('Remove the stored token for a profile')
    .argument('<name>', 'Profile name')
    .action((name: string) => {
      try {
        if (!getProfile(name)) {
          console.error(chalk.red(`❌ Profile "${name}" does not exist.`));
          process.exit(1);
        }
        deleteToken(name);
        console.log(
          chalk.green(`✅ Token for profile "${chalk.cyan(name)}" removed.`)
        );
      } catch (err) {
        console.error(chalk.red(`❌ ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
