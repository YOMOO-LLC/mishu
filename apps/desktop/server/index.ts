import 'dotenv/config'
import { createTwilioHelperServer } from './app'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const server = createTwilioHelperServer(host, port)

server.listen(port, host, () => {
  console.log(`Twilio helper listening at http://${host}:${port}`)
})
