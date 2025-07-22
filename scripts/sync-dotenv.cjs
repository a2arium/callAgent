#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Only run in library development mode
const isLibraryDevelopment = (
  fs.existsSync(path.resolve(__dirname, '../packages')) && // Has packages dir
  fs.existsSync(path.resolve(__dirname, '../apps')) && // Has apps dir (monorepo structure)
  !process.env.CI && // Not in CI
  process.env.NODE_ENV !== 'production' // Not production
);

if (!isLibraryDevelopment) {
  console.log('🔧 Skipping .env sync - not in library development mode');
  process.exit(0);
}

const rootEnv = path.resolve(__dirname, '../.env');
const targets = [
  path.resolve(__dirname, '../packages/memory-sql/.env'),
  // Add more targets here if needed
];

if (!fs.existsSync(rootEnv)) {
  console.warn('⚠️  No .env file found at project root. Skipping propagation.');
  console.log('💡 Create a .env file at the project root for development convenience.');
  process.exit(0);
}

console.log('🔗 Propagating .env for library development...');

targets.forEach(target => {
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    fs.symlinkSync(rootEnv, target);
    console.log(`✅ Symlinked .env to ${path.relative(__dirname + '/..', target)}`);
  } catch (err) {
    // If symlink fails (e.g., on Windows), fallback to copy
    fs.copyFileSync(rootEnv, target);
    console.log(`✅ Copied .env to ${path.relative(__dirname + '/..', target)}`);
  }
});

console.log('🎉 Environment setup complete for library development!'); 