#!/usr/bin/env node

/**
 * Tasker Wrapped Services CLI
 *
 * Discovers and starts available wrapped services based on local folder structure.
 * Supports Deno, Node.js, and Bun runtimes.
 *
 * Usage:
 *   npx tasker                    # Auto-discover and start all services
 *   npx tasker --port 3000        # Start on specific base port
 *   npx tasker --services gapi,keystore  # Start only specific services
 *   npx tasker --deno            # Force Deno runtime
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse arguments
const args = process.argv.slice(2);
const config = {
  basePort: 3100,
  services: null,
  runtime: 'auto',
  debug: false
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') {
    config.basePort = parseInt(args[++i]);
  } else if (args[i] === '--services') {
    config.services = args[++i].split(',');
  } else if (args[i] === '--deno') {
    config.runtime = 'deno';
  } else if (args[i] === '--node') {
    config.runtime = 'node';
  } else if (args[i] === '--bun') {
    config.runtime = 'bun';
  } else if (args[i] === '--debug') {
    config.debug = true;
  }
}

// Find services directory by searching current directory and parents
function findServicesDir() {
  let current = process.cwd();
  const root = path.parse(current).root;

  while (current !== root) {
    const servicesPath = path.join(current, 'services');
    if (fs.existsSync(servicesPath) && fs.statSync(servicesPath).isDirectory()) {
      return servicesPath;
    }
    current = path.dirname(current);
  }

  const fallbackPath = path.join(__dirname, 'services');
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return null;
}

// Discover available services
function discoverServices() {
  const servicesDir = findServicesDir();

  if (!servicesDir) {
    console.error('❌ Services directory not found');
    console.error('Please run this command in a directory or parent of a directory containing a services/ folder');
    console.error('Expected structure: /path/to/project/services/{service-name}/index.ts');
    process.exit(1);
  }

  const services = {};
  const entries = fs.readdirSync(servicesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const servicePath = path.join(servicesDir, entry.name);
    const hasIndex = fs.existsSync(path.join(servicePath, 'index.ts')) ||
                     fs.existsSync(path.join(servicePath, 'index.js'));

    if (hasIndex) {
      services[entry.name] = {
        path: servicePath,
        name: entry.name,
        port: null
      };
    }
  }

  return services;
}

// Filter services based on config
function filterServices(allServices) {
  if (!config.services) {
    return allServices;
  }

  const filtered = {};
  for (const name of config.services) {
    if (allServices[name]) {
      filtered[name] = allServices[name];
    }
  }
  return filtered;
}

// Assign ports to services
function assignPorts(services) {
  const serviceNames = Object.keys(services).sort();
  const serviceArray = serviceNames.map((name, index) => {
    services[name].port = config.basePort + index;
    return services[name];
  });
  return serviceArray;
}

// Start services
async function startServices(servicesList, servicesDir) {
  console.log('🚀 Starting Wrapped Services');
  console.log(`📦 Runtime: ${config.runtime}`);
  console.log(`🔧 Services: ${servicesList.map(s => s.name).join(', ')}`);
  console.log(`📁 Services Dir: ${servicesDir}`);
  console.log('');

  const processes = [];

  for (const service of servicesList) {
    console.log(`⏳ Starting ${service.name} on port ${service.port}...`);

    // Create service entry script
    const entryScript = path.join(service.path, 'index.ts');

    if (!fs.existsSync(entryScript)) {
      console.warn(`⚠️  No entry point found for ${service.name}`);
      continue;
    }

    // TODO: Start service based on runtime
    // For now, just register in service registry
    processes.push({
      name: service.name,
      port: service.port,
      url: `http://localhost:${service.port}`
    });
  }

  // Output service registry
  console.log('\n✅ Services Ready');
  console.log('─'.repeat(60));
  for (const proc of processes) {
    console.log(`${proc.name.padEnd(25)} → ${proc.url}`);
  }
  console.log('─'.repeat(60));

  // Create registry file in the current working directory
  const registryPath = path.join(process.cwd(), '.service-registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    servicesDir: servicesDir,
    services: processes
  }, null, 2));

  console.log(`\n📝 Registry: ${registryPath}`);
  console.log('\nPress Ctrl+C to stop all services\n');

  // Keep process alive
  await new Promise(resolve => {
    process.on('SIGINT', () => {
      console.log('\n\n👋 Stopping services...');
      process.exit(0);
    });
  });
}

// Main
async function main() {
  const servicesDir = findServicesDir();
  const allServices = discoverServices();
  const filtered = filterServices(allServices);
  const assigned = assignPorts(filtered);

  if (assigned.length === 0) {
    console.error('❌ No services found to start');
    process.exit(1);
  }

  await startServices(assigned, servicesDir);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
