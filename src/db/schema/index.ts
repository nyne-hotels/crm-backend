// Drizzle schema for the Nyne Hotels CRM – mirrors docs/schema.sql.
// Tables, checks and indexes live here. Functions, triggers and views can't be
// expressed in Drizzle, so they are in the hand-written migration
// drizzle/0001_functions_triggers_views.sql. Views are declared in views.ts for typed queries.
export * from './auth.js';
export * from './core.js';
export * from './reference.js';
export * from './contacts.js';
export * from './stays.js';
export * from './sales.js';
export * from './data-issues.js';
export * from './imports.js';
export * from './marketing.js';
export * from './views.js';
