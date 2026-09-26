#!/usr/bin/env node

/**
 * Focused validation for .github/dependabot.yml configuration
 * Validates basic structure and required properties without external dependencies
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const DEPENDABOT_CONFIG_PATH = '.github/dependabot.yml';

function validateDependabotConfig() {
  console.log('🔍 Validating Dependabot configuration...');
  
  // Check if file exists
  if (!existsSync(DEPENDABOT_CONFIG_PATH)) {
    console.error('❌ .github/dependabot.yml does not exist');
    process.exit(1);
  }
  
  let config;
  try {
    // Read and parse YAML manually (avoiding external deps)
    const content = readFileSync(DEPENDABOT_CONFIG_PATH, 'utf8');
    
    // Basic YAML validation - check it's not obviously malformed
    if (!content.includes('version:') || !content.includes('updates:')) {
      throw new Error('Missing required top-level keys');
    }
    
    console.log('✅ Configuration file exists and has basic structure');
    
    // Check for required ecosystems
    const requiredEcosystems = ['npm', 'docker', 'github-actions'];
    const missingEcosystems = requiredEcosystems.filter(ecosystem => 
      !content.includes(`package-ecosystem: "${ecosystem}"`)
    );
    
    if (missingEcosystems.length > 0) {
      console.error(`❌ Missing required ecosystems: ${missingEcosystems.join(', ')}`);
      process.exit(1);
    }
    
    console.log('✅ All required ecosystems configured (npm, docker, github-actions)');
    
    // Check for weekly schedule
    const weeklySchedules = (content.match(/interval: "weekly"/g) || []).length;
    if (weeklySchedules < 3) {
      console.error('❌ Not all ecosystems have weekly schedule configured');
      process.exit(1);
    }
    
    console.log('✅ All updates scheduled weekly');
    
    // Check for grouping to reduce PR noise
    const groups = ['npm-dependencies', 'docker-dependencies', 'github-actions'];
    const missingGroups = groups.filter(group => !content.includes(group));
    
    if (missingGroups.length > 0) {
      console.error(`❌ Missing dependency groups: ${missingGroups.join(', ')}`);
      process.exit(1);
    }
    
    console.log('✅ Dependency grouping configured to reduce PR noise');
    
    // Check for labels
    if (!content.includes('labels:') || !content.includes('dependencies')) {
      console.error('❌ Dependencies label not configured');
      process.exit(1);
    }
    
    console.log('✅ Dependencies label configured');
    
    // Check npm configuration points to root (workspace setup)
    if (!content.includes('directory: "/"')) {
      console.error('❌ npm ecosystem not configured for workspace root');
      process.exit(1);
    }
    
    console.log('✅ npm configured for workspace root directory');
    
    console.log('\n🎉 Dependabot configuration validation passed!');
    
  } catch (error) {
    console.error('❌ Configuration validation failed:', error.message);
    process.exit(1);
  }
}

// Run validation
validateDependabotConfig();