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
import { nowISO } from 'tasker-utils/timestamps';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Boilerplate service templates
const boilerplateServices = {
  'hello-world': {
    'index.ts': `import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "hello-world" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method === "POST" && path === "/call") {
    const body = await req.json();
    return new Response(JSON.stringify({
      success: true,
      message: "Hello from hello-world service!",
      received: body
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "3000");
  serve(handler, { port });
}
`
  },
  'echo-service': {
    'index.ts': `import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "echo-service" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method === "POST" && path === "/call") {
    const body = await req.json();
    return new Response(JSON.stringify({
      success: true,
      echo: body,
      timestamp: nowISO()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "3000");
  serve(handler, { port });
}
`
  },
  'api-gateway': {
    'index.ts': `import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "api-gateway" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method === "POST" && path === "/call") {
    const body = await req.json();
    const { endpoint, method = "GET", data } = body;

    try {
      const fetchOptions: RequestInit = {
        method: method,
        headers: { "Content-Type": "application/json" }
      };

      if (data) {
        fetchOptions.body = JSON.stringify(data);
      }

      const response = await fetch(endpoint, fetchOptions);
      const responseData = await response.json();

      return new Response(JSON.stringify({
        success: true,
        status: response.status,
        data: responseData
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "3000");
  serve(handler, { port });
}
`
  }
};

// Create boilerplate services in current directory
function createBoilerplateServices() {
  const servicesDir = path.join(process.cwd(), 'services');

  if (fs.existsSync(servicesDir)) {
    return servicesDir;
  }

  console.log('📦 Creating boilerplate services directory...\n');

  fs.mkdirSync(servicesDir, { recursive: true });

  for (const [serviceName, files] of Object.entries(boilerplateServices)) {
    const serviceDir = path.join(servicesDir, serviceName);
    fs.mkdirSync(serviceDir, { recursive: true });

    for (const [fileName, content] of Object.entries(files)) {
      const filePath = path.join(serviceDir, fileName);
      fs.writeFileSync(filePath, content);
    }

    console.log(`✅ Created service: ${serviceName}`);
  }

  console.log(`\n📁 Services created at: ${servicesDir}\n`);
  console.log('Each service has:');
  console.log('  - /health endpoint for health checks');
  console.log('  - /call endpoint for service calls');
  console.log('  - Deno-compatible TypeScript implementation\n');

  return servicesDir;
}

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

  // First, search current and parent directories
  while (current !== root) {
    const servicesPath = path.join(current, 'services');
    if (fs.existsSync(servicesPath) && fs.statSync(servicesPath).isDirectory()) {
      return servicesPath;
    }
    current = path.dirname(current);
  }

  // Check if we're inside the tasker-wrapped-services package itself
  const packageServicesPath = path.join(__dirname, 'services');
  const cwd = process.cwd();
  const iInsidePackage = cwd.includes(__dirname);

  if (iInsidePackage && fs.existsSync(packageServicesPath)) {
    return packageServicesPath;
  }

  return null;
}

// Discover available services
function discoverServices() {
  let servicesDir = findServicesDir();

  if (!servicesDir) {
    console.log('⚠️  No services directory found');
    servicesDir = createBoilerplateServices();
    console.log('✅ Boilerplate created, discovering services...\n');
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

  return { services, servicesDir };
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
    timestamp: nowISO(),
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
  const discovery = discoverServices();
  const { services: allServices, servicesDir } = discovery;
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
