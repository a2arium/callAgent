#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootEnv = path.resolve(__dirname, '../.env');
const targets = [
  path.resolve(__dirname, '../packages/memory-sql/.env'),
  // Add more targets here if needed
];

if (!fs.existsSync(rootEnv)) {
  console.warn('No .env file found at project root. Skipping propagation.');
  process.exit(0);
}

targets.forEach(target => {
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    fs.symlinkSync(rootEnv, target);
    console.log(`Symlinked .env to ${target}`);
  } catch (err) {
    // If symlink fails (e.g., on Windows), fallback to copy
    fs.copyFileSync(rootEnv, target);
    console.log(`Copied .env to ${target}`);
  }
}); 