import { handleVoiceTranscription } from '../server/voiceTranscription.js';

export const config = { maxDuration: 60 };
export default handleVoiceTranscription;
