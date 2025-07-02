#!/usr/bin/env node

// Export all the functionality from the server and API modules
export * from './server.js';
export * from './onshapeApi.js';

// Add the CLI functionality
if (import.meta.url === import.meta.resolve(process.argv[1])) {
  // CLI entry point code here
  //console.log('Onshape MCP Server starting...');
  // Initialize and start the server when run directly
} 