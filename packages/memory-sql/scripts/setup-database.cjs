#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load .env file if it exists
function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').replace(/^["']|["']$/g, ''); // Remove quotes
          if (!process.env[key]) { // Only set if not already set
            process.env[key] = value;
          }
        }
      }
    });
    console.log(`🔧 Loaded environment variables from .env`);
  }
}

function printHelp() {
  console.log(`
🧠 CallAgent Memory SQL Database Setup

USAGE:
  npx @a2arium/callagent-memory-sql <command>

COMMANDS:
  setup      Set up the database schema (runs migrations and generates client)
  migrate    Run database migrations only
  generate   Generate Prisma client only
  studio     Open Prisma Studio database viewer
  help       Show this help

PREREQUISITES:
  Set your database URL using ONE of these methods:
  
  1. Create a .env file in your project root:
     DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"
     
  2. Export as environment variable:
     export DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"
     # OR
     export MEMORY_DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

EXAMPLES:
  # Full setup (recommended for first time)
  npx @a2arium/callagent-memory-sql setup

  # Update existing database schema
  npx @a2arium/callagent-memory-sql migrate
  
  # Open database viewer
  npx @a2arium/callagent-memory-sql studio
  `);
}

function checkDatabaseUrl() {
  // First try to load .env file
  loadEnvFile();
  
  const dbUrl = process.env.DATABASE_URL || process.env.MEMORY_DATABASE_URL;
  if (!dbUrl) {
    console.error(`
❌ Database URL not found!

Please set your database URL using ONE of these methods:

1. Create a .env file in your project root:
   DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

2. Export as environment variable:
   export DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"
   export MEMORY_DATABASE_URL="postgresql://user:pass@localhost:5432/yourdb"

For more help, run: npx @a2arium/callagent-memory-sql help
    `);
    process.exit(1);
  }
  
  console.log(`✅ Database URL configured`);
  return dbUrl;
}

function runCommand(command, description) {
  console.log(`🔧 ${description}...`);
  try {
    execSync(command, { 
      stdio: 'inherit',
      cwd: __dirname + '/..'
    });
    console.log(`✅ ${description} completed`);
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.message);
    process.exit(1);
  }
}

function main() {
  const command = process.argv[2] || 'help';
  
  switch (command) {
    case 'setup':
      checkDatabaseUrl();
      runCommand('npx prisma migrate deploy', 'Running database migrations');
      runCommand('npx prisma generate', 'Generating Prisma client');
      console.log(`
🎉 Database setup complete!

Your CallAgent memory database is ready to use. You can now:

1. Import the adapters in your code:
   import { MemorySQLAdapter } from '@a2arium/callagent-memory-sql';

2. Create agents with memory:
   const agent = createAgent(manifest, handler, {
     memory: {
       database: {
         url: process.env.DATABASE_URL
       }
     }
   });

3. View your database:
   npx @a2arium/callagent-memory-sql studio

For more examples, see: https://github.com/a2arium/callagent
      `);
      break;
      
    case 'migrate':
      checkDatabaseUrl();
      runCommand('npx prisma migrate deploy', 'Running database migrations');
      break;
      
    case 'generate':
      runCommand('npx prisma generate', 'Generating Prisma client');
      break;
      
    case 'studio':
      checkDatabaseUrl();
      console.log(`
🎨 Opening Prisma Studio...
📍 URL: http://localhost:5555
🔍 Use Ctrl+C to stop the studio server
      `);
      runCommand('npx prisma studio', 'Starting Prisma Studio');
      break;
      
    case 'help':
    default:
      printHelp();
      break;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, printHelp, checkDatabaseUrl, runCommand }; 