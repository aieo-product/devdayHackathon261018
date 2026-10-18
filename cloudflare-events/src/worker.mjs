import { timingSafeEqual } from 'node:crypto';
import { OAuthService } from './oauth.mjs';
import { EventBroker, EVENT_DEFINITION } from './broker.mjs';
import { DeviceRegistry, DeviceError } from './devices.mjs';

const PROTOCOL_VERSION = '2026-07-28';
const SCOPE_READ = 'focus:read';
const SCOPE_EVENTS = 'focus:events';
const SCOPE_CONTROL = 'focus:control';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const securityHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json', ...headers } });
const rpcError = (id, code, message, status = 400, data) => json({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } }, status);
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
const authSchemes = [{ type: 'oauth2', scopes: [SCOPE_READ] }];
const TOOLS = [
  { name: 'get_profile', title: '接続中のFocusプロフィール', description: 'Return the stable profile represented by the authenticated connection. Each connected Mac source has a separate opaque identity.', inputSchema: emptySchema, outputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations, securitySchemes: authSchemes, _meta: { 'openai/profile': true } },
  { name: 'get_focus_status', title: 'Focusイベントの接続状態', description: 'Read subscription and delivery status for this connected Mac. No camera access or session control is performed.', inputSchema: emptySchema, outputSchema: { type: 'object' }, annotations, securitySchemes: authSchemes },
  { name: 'get_focus_events', title: 'スマホ保持検知の履歴', description: 'Read recent smartphone-hold events from this connected Mac, optionally restricted to a focus session. These are observed activity records, not a measure of health or productivity.', inputSchema: { type: 'object', properties: { session_id: { type: 'string', minLength: 1, maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }, outputSchema: { type: 'object' }, annotations, securitySchemes: authSchemes },
  { name: 'list_focus_devices', title: '監視デバイスの一覧と動作状態', description: 'List devices paired to this profile. desired_state is the latest command; observed_state is the last device report. Offline devices have not confirmed current camera state.', inputSchema: emptySchema, outputSchema: { type: 'object' }, annotations, securitySchemes: authSchemes },
  { name: 'set_device_monitoring', title: '監視デバイスのON/OFF', description: 'Request camera monitoring ON or OFF for a paired device. ON requires the device online and locally armed for remote control. This controls monitoring, not physical power. Every call issues a new command revision. Commands are pending until acknowledged; check list_focus_devices for actual state.', inputSchema: { type: 'object', properties: { device_id: { type: 'string', minLength: 1, maxLength: 128 }, enabled: { type: 'boolean' } }, required: ['device_id', 'enabled'], additionalProperties: false }, outputSchema: { type: 'object' }, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false }, securitySchemes: [{ type: 'oauth2', scopes: [SCOPE_CONTROL] }] },
];
async function readJson(request, limit = 64 * 1024) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  if (Number(request.headers.get('content-length')) > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new Error('JSON body required.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON.'); }
  if (!object(value)) throw new Error('A single JSON object is required.');
  return value;
}
function adminAuthorized(request, env) {
  if (!env.INGEST_TOKEN || env.INGEST_TOKEN.length < 32) return false;
  const actual = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${env.INGEST_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function originAllowed(request, origin) {
  const value = request.headers.get('origin');
  return !value || [origin, 'https://chatgpt.com', 'https://chat.openai.com'].includes(value);
}
function checkParams(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Object.assign(new Error('Invalid parameters.'), { code: -32602 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'focus-events', protocol_version: PROTOCOL_VERSION, configured: Boolean(env.FOCUS_EVENTS && env.INGEST_TOKEN && env.PUBLIC_ORIGIN) });
    if (request.method === 'GET' && url.pathname === '/') return json({ name: 'Focus MCP Events', mcp: `${url.origin}/mcp`, event: 'focus.phone_held', authentication: 'OAuth 2.1 with one-time Mac pairing code', documentation: 'https://github.com/aieo-product/devdayHackathon261018/tree/feat/mcp-events-dots/cloudflare-events' });
    if (!env.FOCUS_EVENTS || !env.PUBLIC_ORIGIN) return json({ error: 'service_not_configured' }, 503);
    try {
      return await env.FOCUS_EVENTS.get(env.FOCUS_EVENTS.idFromName('focus-events-v1')).fetch(request);
    } catch { return json({ error: 'service_unavailable' }, 503); }
  },
};

export class FocusEventsStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.origin = new URL(env.PUBLIC_ORIGIN).origin;
    this.oauth = new OAuthService({ storage: ctx.storage, origin: this.origin });
    this.devices = new DeviceRegistry({ storage: ctx.storage });
    const allowedHosts = (env.MCP_CALLBACK_HOSTS || 'chatgpt.com,chat.openai.com,api.openai.com').split(',').map(value => value.trim()).filter(Boolean);
    this.broker = new EventBroker({ storage: ctx.storage, allowedHosts, isGrantActive: (grantId, principal) => this.oauth.isGrantActive(grantId, principal) });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/mcp') return this.mcp(request);
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) {
      try { return await this.oauth.handle(request) || json({ error: 'not_found' }, 404); }
      catch { return json({ error: 'server_error' }, 500); }
    }
    if (['/events/ingest', '/admin/pairing', '/devices/heartbeat', '/devices/list', '/devices/control'].includes(path)) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      if (!adminAuthorized(request, this.env)) return json({ error: 'unauthorized' }, 401);
      try {
        const body = await readJson(request);
        if (typeof body.source_id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.source_id)) return json({ error: 'invalid_source_id' }, 400);
        if (path === '/admin/pairing') {
          checkParams(body, ['source_id']);
          return json(await this.oauth.createPairing(body.source_id), 201);
        }
        if (path === '/devices/list') {
          checkParams(body, ['source_id']);
          return json(await this.devices.list(body.source_id));
        }
        if (path === '/devices/heartbeat' || path === '/devices/control') {
          const { source_id, ...device } = body;
          return json(path === '/devices/heartbeat' ? await this.devices.heartbeat(source_id, device) : await this.devices.setDesired(source_id, device));
        }
        checkParams(body, ['source_id', 'event']);
        const result = await this.broker.ingest(body.source_id, body.event);
        this.ctx.waitUntil(this.broker.drain().catch(() => {}));
        return json(result, 202);
      } catch (error) {
        if (error instanceof DeviceError) return json({ error: error.code, message: error.message }, error.status);
        return json({ error: error.code === -32029 ? 'capacity_exceeded' : error.status === 413 ? 'body_too_large' : 'invalid_request' }, error.code === -32029 ? 429 : error.status || 400);
      }
    }
    return json({ error: 'not_found' }, 404);
  }

  async mcp(request) {
    if (!originAllowed(request, this.origin)) return rpcError(undefined, -32600, 'Origin not allowed.', 403);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const identity = await this.oauth.authenticate(request);
    if (!identity) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource", scope="${SCOPE_READ} ${SCOPE_EVENTS} ${SCOPE_CONTROL}"` });
    let rpc;
    try { rpc = await readJson(request); }
    catch (error) { return rpcError(null, -32700, 'Invalid or oversized JSON request.', error.status || 400); }
    if (rpc.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof rpc.id) || (typeof rpc.id === 'number' && !Number.isSafeInteger(rpc.id)) || typeof rpc.method !== 'string' || !object(rpc.params)) return rpcError(null, -32600, 'Invalid JSON-RPC request.');
    const meta = rpc.params._meta;
    const version = request.headers.get('MCP-Protocol-Version');
    if (!version || !object(meta) || version !== meta['io.modelcontextprotocol/protocolVersion'] || request.headers.get('Mcp-Method') !== rpc.method || (rpc.method === 'tools/call' && request.headers.get('Mcp-Name') !== rpc.params.name)) return rpcError(rpc.id, -32020, 'Required MCP headers and body metadata must match.');
    if (version !== PROTOCOL_VERSION) return rpcError(rpc.id, -32022, 'Unsupported MCP protocol version.', 400, { supported: [PROTOCOL_VERSION], requested: version });
    if (!object(meta['io.modelcontextprotocol/clientCapabilities'])) return rpcError(rpc.id, -32602, 'Client capabilities metadata is required.');
    const { _meta, ...params } = rpc.params;
    const scopes = new Set(identity.scope.split(' '));
    const requiredScope = rpc.method === 'tools/call' && params.name === 'set_device_monitoring' ? SCOPE_CONTROL : rpc.method.startsWith('events/') ? SCOPE_EVENTS : SCOPE_READ;
    if (!scopes.has(requiredScope)) return json({ error: 'insufficient_scope' }, 403, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}"` });
    let result;
    try {
      switch (rpc.method) {
        case 'server/discover':
          result = { supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {}, events: {} }, ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'focus-events', version: '1.0.0' } } }; break;
        case 'tools/list':
          checkParams(params, ['cursor']);
          if (params.cursor != null) throw Object.assign(new Error('Unknown cursor.'), { code: -32602 });
          result = { tools: TOOLS, ttlMs: 0, cacheScope: 'private' }; break;
        case 'tools/call': {
          checkParams(params, ['name', 'arguments']);
          const args = params.arguments ?? {};
          if (params.name === 'get_profile') { checkParams(args, []); result = output({ id: identity.principal, name: 'Focus Mac' }); }
          else if (params.name === 'get_focus_status') { checkParams(args, []); result = output(await this.broker.status(identity.principal)); }
          else if (params.name === 'list_focus_devices') { checkParams(args, []); result = output(await this.devices.list(identity.principal)); }
          else if (params.name === 'set_device_monitoring') { result = output(await this.devices.setDesired(identity.principal, args)); }
          else if (params.name === 'get_focus_events') {
            checkParams(args, ['session_id', 'limit']);
            if ((args.session_id !== undefined && (typeof args.session_id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args.session_id))) || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))) throw Object.assign(new Error('Invalid event query.'), { code: -32602 });
            result = output(await this.broker.recent(identity.principal, args));
          } else throw Object.assign(new Error('Unknown tool.'), { code: -32602 });
          break;
        }
        case 'events/list':
          checkParams(params, ['cursor']);
          if (params.cursor != null) throw Object.assign(new Error('Unknown cursor.'), { code: -32602 });
          result = { events: [EVENT_DEFINITION] }; break;
        case 'events/subscribe': result = await this.broker.subscribe(identity.principal, identity.grantId, params); break;
        case 'events/unsubscribe': result = await this.broker.unsubscribe(identity.principal, params); break;
        default: return rpcError(rpc.id, -32601, 'Method not found.', 404);
      }
      return json({ jsonrpc: '2.0', id: rpc.id, result: { ...result, resultType: 'complete' } });
    } catch (error) {
      if (error instanceof DeviceError) return json({ jsonrpc: '2.0', id: rpc.id, result: { ...output({ error: error.code, message: error.message }), isError: true, resultType: 'complete' } });
      const safeCodes = new Set([-32602, -32015, -32000, -32001, -32029]);
      return rpcError(rpc.id, safeCodes.has(error.code) ? error.code : -32603, safeCodes.has(error.code) ? error.message : 'Internal error.', 200, safeCodes.has(error.code) ? error.data : undefined);
    }
  }

  async alarm() { await this.broker.drain(); }
}
