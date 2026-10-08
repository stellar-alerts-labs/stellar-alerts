#!/usr/bin/env tsx
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';

const generateSystemdService = () => {
  const serviceContent = `[Unit]
Description=Stellar Alerts Daemon
After=network.target

[Service]
Type=simple
User=${process.env.USER}
WorkingDirectory=${process.cwd()}
Environment="NODE_ENV=production"
ExecStart=${process.execPath} ${path.join(process.cwd(), 'apps/api/src/server.ts')}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

  const servicePath = '/etc/systemd/system/stellar-alerts.service';
  return { content: serviceContent, path: servicePath };
};

const generateLaunchdPlist = () => {
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stellaralerts.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${path.join(process.cwd(), 'apps/api/src/server.ts')}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${process.cwd()}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(os.homedir(), 'Library/Logs/stellar-alerts.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(os.homedir(), 'Library/Logs/stellar-alerts-error.log')}</string>
</dict>
</plist>
`;

  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents/com.stellaralerts.daemon.plist');
  return { content: plistContent, path: plistPath };
};

const installSystemdService = () => {
  const { content, path: servicePath } = generateSystemdService();
  
  console.log(`Writing systemd service to ${servicePath}`);
  fs.writeFileSync(servicePath, content);
  
  console.log('Reloading systemd daemon...');
  console.log('Run the following commands as root:');
  console.log(`  sudo systemctl daemon-reload`);
  console.log(`  sudo systemctl enable stellar-alerts`);
  console.log(`  sudo systemctl start stellar-alerts`);
};

const installLaunchdService = () => {
  const { content, path: plistPath } = generateLaunchdPlist();
  
  console.log(`Writing launchd plist to ${plistPath}`);
  fs.writeFileSync(plistPath, content);
  
  console.log('Loading launchd service...');
  console.log('Run the following command:');
  console.log(`  launchctl load ${plistPath}`);
};

const startDaemon = () => {
  console.log('Starting Stellar Alerts daemon in headless mode...');
  process.env.START_WORKER = 'true';
  
  require('../server');
};

program
  .name('stellar-alerts-daemon')
  .description('Stellar Alerts daemon management')
  .version('1.0.0');

program
  .command('start')
  .description('Start the daemon in headless mode')
  .action(startDaemon);

program
  .command('install:systemd')
  .description('Generate and install systemd service file (Linux)')
  .action(installSystemdService);

program
  .command('install:launchd')
  .description('Generate and install launchd plist file (macOS)')
  .action(installLaunchdService);

program
  .command('generate:systemd')
  .description('Generate systemd service file without installing')
  .action(() => {
    const { content, path: servicePath } = generateSystemdService();
    console.log('=== Systemd Service File ===');
    console.log(`Path: ${servicePath}`);
    console.log(content);
  });

program
  .command('generate:launchd')
  .description('Generate launchd plist file without installing')
  .action(() => {
    const { content, path: plistPath } = generateLaunchdPlist();
    console.log('=== Launchd Plist File ===');
    console.log(`Path: ${plistPath}`);
    console.log(content);
  });

if (require.main === module) {
  program.parse();
}

export { generateSystemdService, generateLaunchdPlist };
