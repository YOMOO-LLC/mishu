import { z } from 'zod'
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER
} from '../webhook/types.js'
import { API_ROUTES, ErrorResponseSchema } from './routes/definitions.js'

const WEBHOOK_SIGNATURE_PATTERN = '^t=\\d+,v1=[0-9a-f]{64}$'

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of API_ROUTES) {
    const operation: Record<string, unknown> = {
      summary: route.summary,
      operationId: operationId(route.method, route.path),
      security: [{ bearerAuth: [] }],
      responses: {
        [String(route.status ?? 200)]: {
          description: route.status === 202 ? 'Accepted' : 'Successful response',
          content: { [route.responseContentType ?? 'application/json']: { schema: z.toJSONSchema(route.response, { target: 'draft-2020-12' }) } }
        },
        default: {
          description: 'Error response',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } }
        }
      }
    }
    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: z.toJSONSchema(route.body, { target: 'draft-2020-12' }) } }
      }
    }
    const parameters: Record<string, unknown>[] = []
    for (const name of route.path.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({ name: name[1], in: 'path', required: true, schema: { type: 'string' } })
    }
    if (route.query instanceof z.ZodObject) {
      for (const [name, schema] of Object.entries(route.query.shape)) {
        parameters.push({ name, in: 'query', required: false, schema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) })
      }
    }
    if (parameters.length > 0) operation.parameters = parameters
    ;(paths[route.path] ??= {})[route.method.toLowerCase()] = operation
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Mishu API', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '0' } } }],
    paths,
    'x-webhook-delivery': {
      contentType: 'application/json',
      signatureFormat: 't=<unix-ms>,v1=<hex>',
      signedInput: '{unix-ms}.{rawBody}',
      headers: {
        [WEBHOOK_SIGNATURE_HEADER]: 'HMAC-SHA256 over the signed input; required for verification',
        [WEBHOOK_EVENT_HEADER]: 'Webhook event type, for example webhook.test',
        [WEBHOOK_DELIVERY_ID_HEADER]: 'Stable delivery id; retries reuse the same value'
      }
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      headers: {
        [WEBHOOK_SIGNATURE_HEADER]: {
          description: 'HMAC-SHA256 signature. Format: t=<unix-ms>,v1=<hex>. Signed bytes are "{unix-ms}.{rawBody}".',
          schema: { type: 'string', pattern: WEBHOOK_SIGNATURE_PATTERN }
        },
        [WEBHOOK_EVENT_HEADER]: {
          description: 'Webhook event type delivered with the payload.',
          schema: { type: 'string' }
        },
        [WEBHOOK_DELIVERY_ID_HEADER]: {
          description: 'Stable delivery identifier. Retries reuse the same id.',
          schema: { type: 'string', format: 'uuid' }
        }
      },
      schemas: {
        ErrorResponse: z.toJSONSchema(ErrorResponseSchema, { target: 'draft-2020-12' })
      }
    }
  }
}

function operationId(method: string, path: string): string {
  return `${method.toLowerCase()}_${path.replace(/^\/v1\/?/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`
}
