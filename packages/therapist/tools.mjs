const nullableUuid = { type: ['string', 'null'], format: 'uuid' };
const uuid = { type: 'string', format: 'uuid' };
const nullableInteger = { type: ['integer', 'null'], minimum: 1, maximum: 100 };
const nullableStatus = { type: ['string', 'null'], enum: ['pending', 'active', 'settled', null] };
const objectTool = (name, description, properties) => ({
  type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

export const TOOL_DEFINITIONS = Object.freeze([
  objectTool('list_threads', 'List threads in the authenticated shared space.', { status: nullableStatus, after_thread_id: nullableUuid, limit: nullableInteger }),
  objectTool('get_thread', 'Read one thread in the authenticated shared space.', { thread_id: uuid }),
  objectTool('get_messages', 'Read a page of messages in an allowed thread.', { thread_id: uuid, after_message_id: nullableUuid, limit: nullableInteger }),
  objectTool('get_message', 'Read one known message in the authenticated shared space.', { message_id: uuid }),
  objectTool('get_agreements', 'List confirmed agreements in the authenticated shared space.', { thread_id: nullableUuid, after_agreement_id: nullableUuid, limit: nullableInteger }),
]);

const definitions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateToolArguments(name, value) {
  const tool = definitions.get(name);
  if (!tool) throw new Error(`Unsupported tool: ${name}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} arguments must be an object`);
  const allowed = tool.parameters.properties;
  for (const key of Object.keys(value)) if (!Object.hasOwn(allowed, key)) throw new Error(`${name} arguments contain unsupported property: ${key}`);
  for (const key of tool.parameters.required) if (!Object.hasOwn(value, key)) throw new Error(`${name} arguments missing required property: ${key}`);
  for (const [key, schema] of Object.entries(allowed)) {
    const item = value[key];
    if (item === null && schema.type.includes?.('null')) continue;
    const baseType = Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type;
    if (baseType === 'string' && typeof item !== 'string') throw new Error(`${name} ${key} must be a UUID string or null`);
    if (baseType === 'integer' && !Number.isInteger(item)) throw new Error(`${name} ${key} must be an integer or null`);
    if (schema.format === 'uuid' && item !== null && !uuidPattern.test(item)) throw new Error(`${name} ${key} must be a UUID`);
    if (schema.minimum && item !== null && item < schema.minimum) throw new Error(`${name} ${key} must be at least ${schema.minimum}`);
    if (schema.maximum && item !== null && item > schema.maximum) throw new Error(`${name} ${key} must be at most ${schema.maximum}`);
    if (schema.enum && !schema.enum.includes(item)) throw new Error(`${name} ${key} has an unsupported value`);
  }
  return { ...value };
}
