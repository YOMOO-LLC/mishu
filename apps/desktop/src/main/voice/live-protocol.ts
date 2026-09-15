/** Wire shapes verified against openai 7.15.0 resources/live/live.d.ts (2026-09-11).
 * Kept local because that SDK release is younger than the repository's install policy.
 */
export type ClientEvent = { type: 'session.close' } | {
  type: 'session.instructions.append' | 'session.thinking.append' | 'session.commentary.append'
  event_id: string
  delegation_id: string | null
  content: string
}
export interface LiveCreateParams {
  session: { model: 'gpt-live-1'; instructions?: string; audio: { output: { voice: string } }; delegation: { type: 'client' } }
  transport: { type: 'webrtc'; sdp: string }
}
export interface LiveCreateResponse {
  session: { id: string }
  transport: { type: 'webrtc'; sdp: string }
}
