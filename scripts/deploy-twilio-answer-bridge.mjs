import 'dotenv/config'
import twilio from 'twilio'

const apply = process.argv.includes('--apply')
/** Private-build Twilio Functions service name. Snapshot export rewrites the value to mishu. */
const APP_TWILIO_FUNCTIONS_SERVICE_NAME = 'mishu'
const serviceName = APP_TWILIO_FUNCTIONS_SERVICE_NAME
const environmentName = 'ui'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const client = twilio(
  required('TWILIO_API_KEY_SID'),
  required('TWILIO_API_KEY_SECRET'),
  { accountSid: required('TWILIO_ACCOUNT_SID') }
)

const services = await client.serverless.v1.services.list({ limit: 50 })
const service = services.find(
  ({ uniqueName, friendlyName }) => uniqueName === serviceName || friendlyName === serviceName
)
if (!service) throw new Error(`Twilio Service ${serviceName} was not found`)

const environments = await client.serverless.v1.services(service.sid).environments.list({ limit: 20 })
const environment = environments.find(({ uniqueName }) => uniqueName === environmentName)
if (!environment) throw new Error(`Twilio environment ${environmentName} was not found`)

const deployments = await client.serverless.v1
  .services(service.sid)
  .environments(environment.sid)
  .deployments.list({ limit: 20 })
const activeDeployment = deployments.sort(
  (left, right) => right.dateCreated.getTime() - left.dateCreated.getTime()
)[0]
if (!activeDeployment) throw new Error('The Twilio environment has no active deployment')

const activeBuild = await client.serverless.v1
  .services(service.sid)
  .builds(activeDeployment.buildSid)
  .fetch()
const functions = await client.serverless.v1.services(service.sid).functions.list({ limit: 50 })

const activeFunctionVersions = []
for (const reference of activeBuild.functionVersions) {
  const owner = functions.find(({ sid }) => sid === reference.function_sid)
  if (!owner) throw new Error('An active Function Version has no matching Function')
  const version = await client.serverless.v1
    .services(service.sid)
    .functions(owner.sid)
    .functionVersions(reference.sid)
    .fetch()
  activeFunctionVersions.push({ owner, version })
}

const outgoing = activeFunctionVersions.find(({ version }) => version.path === '/voice-outgoing')
if (!outgoing) throw new Error('The active /voice-outgoing Function Version was not found')
const current = await client.serverless.v1
  .services(service.sid)
  .functions(outgoing.owner.sid)
  .functionVersions(outgoing.version.sid)
  .functionVersionContent()
  .fetch()

if (/answerOnBridge\s*:\s*true/.test(current.content)) {
  console.log(JSON.stringify({ changed: false, reason: 'already-enabled', path: outgoing.version.path }))
  process.exit(0)
}

const pattern = /response\.dial\(\{\s*callerId\s*:\s*([^,}]+)\s*\}\)/
const updatedContent = current.content.replace(
  pattern,
  'response.dial({ callerId: $1, answerOnBridge: true })'
)
if (updatedContent === current.content || !/answerOnBridge\s*:\s*true/.test(updatedContent)) {
  throw new Error('The active /voice-outgoing source did not match the safe patch pattern')
}

if (!apply) {
  console.log(JSON.stringify({ changed: false, ready: true, path: outgoing.version.path }))
  process.exit(0)
}

const form = new FormData()
form.append('Path', outgoing.version.path)
form.append('Visibility', outgoing.version.visibility)
form.append(
  'Content',
  new Blob([updatedContent], { type: 'application/javascript' }),
  'voice-outgoing.js'
)
const authorization = Buffer.from(
  `${required('TWILIO_API_KEY_SID')}:${required('TWILIO_API_KEY_SECRET')}`
).toString('base64')
const upload = await fetch(
  `https://serverless-upload.twilio.com/v1/Services/${service.sid}/Functions/${outgoing.owner.sid}/Versions`,
  { method: 'POST', headers: { authorization: `Basic ${authorization}` }, body: form }
)
if (!upload.ok) throw new Error(`Twilio Function upload failed with status ${upload.status}`)
const uploaded = await upload.json()
if (typeof uploaded.sid !== 'string') throw new Error('Twilio upload did not return a Function Version SID')

const functionVersions = activeFunctionVersions.map(({ version }) =>
  version.path === outgoing.version.path ? uploaded.sid : version.sid
)
const build = await client.serverless.v1.services(service.sid).builds.create({
  functionVersions,
  assetVersions: activeBuild.assetVersions.map(({ sid }) => sid),
  dependencies: JSON.stringify(activeBuild.dependencies),
  runtime: activeBuild.runtime
})

let completedBuild = build
for (let attempt = 0; attempt < 60 && completedBuild.status === 'building'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  completedBuild = await client.serverless.v1.services(service.sid).builds(build.sid).fetch()
}
if (completedBuild.status !== 'completed') {
  throw new Error(`Twilio Build did not complete successfully: ${completedBuild.status}`)
}

const deployment = await client.serverless.v1
  .services(service.sid)
  .environments(environment.sid)
  .deployments.create({ buildSid: completedBuild.sid })
if (deployment.buildSid !== completedBuild.sid) {
  await client.serverless.v1
    .services(service.sid)
    .environments(environment.sid)
    .deployments.create({ buildSid: activeBuild.sid })
  throw new Error('Twilio activated an unexpected Build; the previous Build was restored')
}

console.log(JSON.stringify({ changed: true, deployed: true, path: outgoing.version.path }))
