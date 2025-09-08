import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

// Load environment variables
dotenv.config();

// Check for required environment variables
const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Enable CORS - THIS FIXES THE CONNECTION ERROR
fastify.register(fastifyCors, {
    origin: true,
    credentials: true
});

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Store active calls and their data
const activeCallSessions = new Map();
const callAttempts = new Map();

// Generate unique call ID
function generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Root route - health check
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Boostly AI SDR is running!' });
});

// Endpoint to trigger outbound calls
fastify.post('/make-call', async (request, reply) => {
    const { to, name, company, email } = request.body;
    
    if (!to || !name || !company) {
        return reply.status(400).send({ 
            error: 'Required: phone number (to), name, and company' 
        });
    }
    
    // Track call attempts
    const attempts = callAttempts.get(to) || 0;
    if (attempts >= 2) {
        return reply.send({ 
            success: false, 
            message: 'Already attempted 2 calls to this number today' 
        });
    }
    
    try {
        const callId = generateCallId();
        
        // Store lead data
        activeCallSessions.set(callId, {
            name,
            company,
            email: email || '',
            phoneNumber: to,
            attemptNumber: attempts + 1
        });
        
        // Make the call
        const call = await twilioClient.calls.create({
            from: TWILIO_PHONE_NUMBER,
            to: to,
            url: `https://${request.headers.host}/outbound-answer?callId=${callId}`,
            statusCallback: `https://${request.headers.host}/call-status?callId=${callId}`,
            statusCallbackEvent: ['answered', 'completed', 'no-answer', 'busy'],
            machineDetection: 'DetectMessageEnd',
            asyncAmd: true,
            timeout: 30
        });
        
        // Update attempts
        callAttempts.set(to, attempts + 1);
        
        reply.send({ 
            success: true, 
            callSid: call.sid,
            message: `Calling ${name} at ${company}...`,
            attemptNumber: attempts + 1
        });
        
    } catch (error) {
        console.error('Error making call:', error);
        reply.status(500).send({ error: 'Failed to initiate call: ' + error.message });
    }
});

// Handle outbound call when answered
fastify.all('/outbound-answer', async (request, reply) => {
    const callId = request.query.callId;
    const leadData = activeCallSessions.get(callId);
    
    // Check if it's an answering machine
    const amdStatus = request.body?.AnsweredBy;
    
    if (amdStatus === 'machine_start' || amdStatus === 'fax' || amdStatus === 'machine_end_beep') {
        // Just hang up on voicemail
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
                      <Response>
                          <Hangup/>
                      </Response>`;
        return reply.type('text/xml').send(twiml);
    }
    
    // Human answered - connect to AI
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream?callId=${callId}" />
                              </Connect>
                          </Response>`;
    
    reply.type('text/xml').send(twimlResponse);
});

// Handle call status updates
fastify.post('/call-status', async (request, reply) => {
    const { CallSid, CallStatus, CallDuration, To } = request.body;
    const callId = request.query.callId;
    const leadData = activeCallSessions.get(callId);
    
    console.log(`Call to ${leadData?.name} (${To}): ${CallStatus}`);
    
    if (CallStatus === 'completed' || CallStatus === 'no-answer' || CallStatus === 'busy') {
        console.log(`Call Result - Name: ${leadData?.name}, Company: ${leadData?.company}, Status: ${CallStatus}, Duration: ${CallDuration}s`);
        
        if ((CallStatus === 'no-answer' || CallStatus === 'busy') && leadData?.attemptNumber === 1) {
            console.log(`Will retry ${leadData?.name} later (attempt 2 of 2)`);
        }
        
        setTimeout(() => {
            activeCallSessions.delete(callId);
        }, 60000);
    }
    
    reply.send({ received: true });
});

// WebSocket for media streaming - FIXED VERSION
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        const callId = req.query.callId;
        const leadData = activeCallSessions.get(callId);
        
        console.log(`Connected to ${leadData?.name} at ${leadData?.company}`);
        
        // Connect to OpenAI with correct model
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        
        let streamSid = null;
        
        // Create Kora's personality and instructions
        const sendSessionUpdate = () => {
            const systemMessage = `You are Kora, Boostly's AI Marketing Assistant. You're calling ${leadData?.name} from ${leadData?.company} who recently filled out a form on Facebook about Boostly's restaurant marketing services.

PERSONALITY:
- Be chill, casual, and friendly but professional
- Sound natural and conversational
- Keep energy positive and upbeat
- Don't be pushy but be confident about Boostly's value

YOUR GOAL:
Qualify them and book a demo if they're the owner and can be at a computer.

SERVICES WE OFFER:
- Text marketing
- Local SEO  
- Social Media Marketing
- Review Responders

CONVERSATION FLOW:
1. INTRODUCTION: "Hey ${leadData?.name}! This is Kora, Boostly's AI marketing assistant. You recently filled out a form on Facebook inquiring about our marketing services for ${leadData?.company}. Got a quick minute to chat?"

2. QUALIFYING QUESTIONS (ask naturally in conversation):
- "What POS and online ordering system do you use?" (Wait for answer, then ask: "How long have you been using those?")
- "Are you the sole owner, or are there partners?"
- "Is it just the one location or are there multiple?"
- "Are you currently doing any marketing? What types?"

3. OBJECTION HANDLING (use MEDDIC):
- If "too busy": "I totally get it! This'll just take 2 minutes and could really help boost your revenue. When would be a better time?"
- If "not interested": "No worries! Can I ask what made you fill out the form initially? Maybe something changed?"
- If "already have marketing": "That's great! A lot of our clients use us alongside other marketing. What are you currently using? We might complement it well."
- If price comes up: "Yeah, I'd love to show you that on a demo! Pricing varies based on your needs."

4. BOOKING THE DEMO:
If qualified (owner + can be at computer):
"Awesome! I'd love to show you exactly how Boostly can help ${leadData?.company}. What works better for you - tomorrow afternoon or [day after] morning? I have slots at [give 2-3 specific times]."

5. WRAP UP:
- If booked: "Perfect! I'll send a calendar invite to confirm. You'll love what we can do for ${leadData?.company}. Talk soon!"
- If not qualified: "No problem! When the owner is available, have them visit Boostly.com or email support@boostly.com. Thanks for your time!"

IMPORTANT RULES:
- Keep the call between 2.5-5 minutes
- Always try to book for next day or day after
- Give specific time options, don't leave it open-ended
- Be persistent but respectful with objections
- If they ask technical details: "Great question! That's exactly what we'll cover in the demo."
- Website: Boostly.com
- Email: support@boostly.com

Remember: You're Kora, not a generic AI. Be personable and build rapport!`;

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: systemMessage,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        model: 'whisper-1'
                    }
                }
            };
            
            console.log('Sending session configuration to OpenAI...');
            openAiWs.send(JSON.stringify(sessionUpdate));
        };
        
        // OpenAI WebSocket opened
        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250);
        });
        
        // Handle OpenAI responses - FIXED AUDIO HANDLING
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // Log response types for debugging
                if (response.type === 'session.created' || response.type === 'session.updated') {
                    console.log('Session event:', response.type);
                }
                
                if (response.type === 'error') {
                    console.error('OpenAI Error:', response.error);
                }
                
                // Handle audio data
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { 
                            payload: response.delta
                        }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
                
                // Log transcriptions for debugging
                if (response.type === 'conversation.item.created' && response.item?.role === 'assistant') {
                    console.log('AI is speaking...');
                }
                
                if (response.type === 'input_audio_buffer.speech_started') {
                    console.log('Caller started speaking...');
                }
                
                if (response.type === 'input_audio_buffer.speech_stopped') {
                    console.log('Caller stopped speaking...');
                }
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });
        
        // Handle incoming audio from Twilio - FIXED
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                switch (data.event) {
                    case 'media':
                        // Forward audio to OpenAI
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                        
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Call started, stream ID:', streamSid);
                        console.log('Call details:', data.start);
                        break;
                        
                    case 'stop':
                        console.log('Call media stream stopped');
                        break;
                }
            } catch (error) {
                console.error('Error parsing Twilio message:', error);
            }
        });
        
        // Handle disconnection
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
            console.log(`Call with ${leadData?.name} ended`);
        });
        
        openAiWs.on('close', () => {
            console.log('Disconnected from OpenAI');
        });
        
        openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Boostly AI SDR running on port ${PORT}`);
});
