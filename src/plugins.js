'use strict';
/**
 * plugins.js — Plugin / Tool SDK.
 *
 * External tools can be registered at runtime WITHOUT rewriting the agent:
 * each plugin declares name, description, JSON schema, risk level, and an
 * execute handler. Registered tools immediately become part of the single
 * tool registry (declared schemas == executable tools can never drift), flow
 * through the same safety gate and approval system, and are visible in
 * /api/tools.
 *
 * This is also the integration point prepared for a future MCP adapter: an
 * MCP bridge would translate MCP tool manifests into the same shape and call
 * registerTool() — inheriting schema validation, risk classification, and
 * approvals for free. (Protocol transport is intentionally NOT implemented
 * yet; claiming MCP support without it would violate the no-fake rule.)
 */

const { TOOL_DEFS, TOOL_NAMES, PROVIDER_TOOL_SCHEMAS, toolSchemasFor } = require('./agent-tools');
const { LEVELS } = require('./risk');

const RISK_BY_TOOL = new Map(); // tool name → risk level declared by its plugin

/**
 * Register an external tool. Validation is strict: duplicate names, missing
 * fields, or an unsafe risk declaration are rejected with a thrown Error.
 * Returns the derived registry views for convenience.
 */
function registerTool(def) {
  const errors = [];
  if (!def || typeof def !== 'object') errors.push('definition must be an object');
  if (!def.name || !/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) errors.push('name must be snake_case, 3-41 chars');
  if (TOOL_NAMES.includes(def.name)) errors.push(`tool "${def.name}" is already registered`);
  if (!def.description || typeof def.description !== 'string') errors.push('description is required');
  if (!def.parameters || def.parameters.type !== 'object') errors.push('parameters must be a JSON schema with type:object');
  if (typeof def.execute !== 'function') errors.push('execute(args, ctx) handler is required');
  if (def.risk && !LEVELS.includes(def.risk)) errors.push(`risk must be one of: ${LEVELS.join(', ')}`);
  if (errors.length) throw new Error(`Invalid tool plugin: ${errors.join('; ')}`);

  TOOL_DEFS.push({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    async execute(args, ctx) {
      try {
        return await def.execute(args, ctx);
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    },
  });
  RISK_BY_TOOL.set(def.name, def.risk || 'medium');

  // Keep the derived views authoritative (including the full-surface schema
  // list the agent loop uses when every tool is allowed).
  TOOL_NAMES.length = 0;
  TOOL_NAMES.push(...TOOL_DEFS.map((t) => t.name));
  PROVIDER_TOOL_SCHEMAS.push({
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.parameters },
  });

  return { TOOL_NAMES: [...TOOL_NAMES], schemas: toolSchemasFor([def.name]) };
}

function declaredRisk(toolName) {
  return RISK_BY_TOOL.get(toolName) || null;
}

module.exports = { registerTool, declaredRisk };
