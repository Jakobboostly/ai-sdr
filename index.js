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
const { 
    OPENAI_API_KEY, 
    TWILIO_ACCOUNT_SID, 
    TWILIO_AUTH_TOKEN, 
    TWILIO_PHONE_NUMBER,
    SLACK_WEBHOOK_URL  // Add this to your .env
} = process.env;

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

// Enable CORS
fastify.register(fastifyCors, {
    origin: true,
    credentials: true
});

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Store active calls and their data
const activeCallSessions = new Map();
const bookedDemos = new Map(); // Store actual booked demos

// ============= DEMO SCHEDULING CONFIGURATION =============
const DEMO_SLOTS = {
    monday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
    tuesday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
    wednesday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
    thursday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
    friday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM"]
};

// ============= NOTIFICATION FUNCTIONS =============
async function sendSlackNotification(demoData) {
    if (!SLACK_WEBHOOK_URL) {
        console.log('⚠️ No Slack webhook configured - skipping notification');
        return;
    }
    
    try {
        const message = {
            text: "🎯 New Boostly Demo Booked!",
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "🎯 New Demo Booked!"
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*Restaurant:*\n${demoData.restaurantName}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Owner:*\n${demoData.ownerName}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Phone:*\n${demoData.phone}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Email:*\n${demoData.email || 'Not provided'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Date/Time:*\n${demoData.datetime}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Rep:*\nJakob`
                        }
                    ]
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Notes:*\n${demoData.notes || 'No notes provided'}`
                    }
                },
                {
                    type: "divider"
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `Booked by Kora AI at ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`
                        }
                    ]
                }
            ]
        };
        
        const response = await fetch(SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message)
        });
        
        if (response.ok) {
            console.log('✅ Slack notification sent successfully');
        } else {
            console.error('❌ Slack notification failed:', response.statusText);
        }
    } catch (error) {
        console.error('❌ Error sending Slack notification:', error);
    }
}

async function sendSMS(demoData) {
    // Send SMS to yourself about the new demo
    try {
        await twilioClient.messages.create({
            body: `New Demo: ${demoData.restaurantName} - ${demoData.ownerName} - ${demoData.datetime}`,
            from: TWILIO_PHONE_NUMBER,
            to: process.env.ADMIN_PHONE || '+13035551234' // Add your phone to .env
        });
        console.log('✅ SMS notification sent');
    } catch (error) {
        console.error('❌ Error sending SMS:', error);
    }
}

// Store demo in a simple JSON file (or database later)
async function storeDemoData(demoData) {
    const demoId = `DEMO-${Date.now()}`;
    const fullDemo = {
        id: demoId,
        ...demoData,
        bookedAt: new Date().toISOString(),
        status: 'scheduled'
    };
    
    // Store in memory for now
    bookedDemos.set(demoId, fullDemo);
    
    // Log to console with formatting
    console.log('\n' + '='.repeat(50));
    console.log('🎯 NEW DEMO BOOKED - ' + demoId);
    console.log('='.repeat(50));
    console.log(`Restaurant: ${demoData.restaurantName}`);
    console.log(`Owner: ${demoData.ownerName}`);
    console.log(`Phone: ${demoData.phone}`);
    console.log(`Email: ${demoData.email || 'Not provided'}`);
    console.log(`Date/Time: ${demoData.datetime}`);
    console.log(`Notes: ${demoData.notes || 'None'}`);
    console.log('='.repeat(50) + '\n');
    
    return demoId;
}
// ============= END NOTIFICATION FUNCTIONS =============

// Generate unique call ID
function generateCallId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Root route - health check
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Boostly AI SDR is running!' });
});

// Endpoint to view booked demos
fastify.get('/demos', async (request, reply) => {
    const demos = Array.from(bookedDemos.values());
    reply.send({
        count: demos.length,
        demos: demos.sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt))
    });
});

// Endpoint to trigger outbound calls
fastify.post('/make-call', async (request, reply) => {
    const { to, name, company, email } = request.body;
    
    if (!to || !name || !company) {
        return reply.status(400).send({ 
            error: 'Required: phone number (to), name, and company' 
        });
    }
    
    try {
        const callId = generateCallId();

        // Store lead data
        activeCallSessions.set(callId, {
            name,
            company,
            email: email || '',
            phoneNumber: to
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

        reply.send({
            success: true,
            callSid: call.sid,
            message: `Calling ${name} at ${company}...`
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
        
        
        setTimeout(() => {
            activeCallSessions.delete(callId);
        }, 60000);
    }
    
    reply.send({ received: true });
});

// ============= MCP CALENDAR ENDPOINTS =============
// MCP endpoint to list available tools
fastify.post('/mcp/list_tools', async (request, reply) => {
    return {
        tools: [
            {
                name: "check_availability",
                description: "Check available demo slots for a specific date",
                parameters: {
                    type: "object",
                    properties: {
                        when: { 
                            type: "string", 
                            description: "Date to check: 'today', 'tomorrow', or day name" 
                        }
                    },
                    required: ["when"]
                }
            },
            {
                name: "book_demo",
                description: "Book a demo appointment",
                parameters: {
                    type: "object",
                    properties: {
                        restaurantName: { type: "string" },
                        ownerName: { type: "string" },
                        phone: { type: "string" },
                        email: { type: "string" },
                        datetime: { type: "string" },
                        notes: { type: "string" }
                    },
                    required: ["restaurantName", "ownerName", "phone", "datetime"]
                }
            }
        ]
    };
});

// MCP endpoint to handle tool calls
fastify.post('/mcp/call_tool', async (request, reply) => {
    const { tool, arguments: args } = request.body;
    
    if (tool === 'check_availability') {
        let targetDate = new Date();
        
        // Parse the when parameter
        if (args.when === 'today') {
            // Already set
        } else if (args.when === 'tomorrow') {
            targetDate.setDate(targetDate.getDate() + 1);
        } else if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(args.when.toLowerCase())) {
            // Find next occurrence of that day
            const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const targetDay = days.indexOf(args.when.toLowerCase());
            const currentDay = targetDate.getDay();
            const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
            targetDate.setDate(targetDate.getDate() + daysUntilTarget);
        }
        
        const dayName = targetDate.toLocaleLowerCase('en-US', { weekday: 'long' });
        const dateStr = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        // Skip weekends
        if (dayName === 'saturday' || dayName === 'sunday') {
            return {
                success: true,
                message: "No demos on weekends",
                slots: []
            };
        }
        
        const allSlots = DEMO_SLOTS[dayName] || [];
        const bookedKey = targetDate.toISOString().split('T')[0];
        
        // Get already booked slots for this date
        const bookedForDate = [];
        bookedDemos.forEach(demo => {
            if (demo.datetime.includes(dateStr)) {
                const time = demo.datetime.split(' at ')[1];
                if (time) bookedForDate.push(time);
            }
        });
        
        const available = allSlots.filter(slot => !bookedForDate.includes(slot));
        
        return {
            success: true,
            date: dateStr,
            dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
            slots: available.map(time => ({
                time,
                display: `${dateStr} at ${time}`
            }))
        };
    }
    
    if (tool === 'book_demo') {
        // Store the demo data
        const demoId = await storeDemoData(args);
        
        // Send notifications
        await sendSlackNotification(args);
        
        // Optionally send SMS
        if (process.env.ADMIN_PHONE) {
            await sendSMS(args);
        }
        
        return {
            success: true,
            confirmationId: demoId,
            message: `Demo confirmed for ${args.ownerName} from ${args.restaurantName}`,
            datetime: args.datetime,
            details: "Jakob will call at the scheduled time. Calendar invite coming shortly."
        };
    }
    
    return { error: 'Unknown tool' };
});
// ============= END MCP CALENDAR ENDPOINTS =============

// WebSocket for media streaming
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        const callId = req.query.callId;
        const leadData = activeCallSessions.get(callId);
        
        console.log(`Connected to ${leadData?.name} at ${leadData?.company}`);
        
        // Connect to OpenAI
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`
            }
        });
        
        let streamSid = null;
        
        // Create Kora's personality and instructions
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    voice: 'alloy',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    instructions: `You are Kora, Boostly's friendly marketing consultant. You're calling ${leadData?.name} from ${leadData?.company} who recently filled out a form on Facebook about restaurant marketing.

PERSONALITY:
- Be super casual and conversational, like talking to a friend
- Natural, not salesy or robotic
- NEVER say "Got it!" or similar acknowledgments
- Keep energy positive but relaxed
- Use restaurant industry language naturally
- IMPORTANT: Pause after asking questions to let them answer fully

YOUR GOAL:
Qualify them (owner check) and book a demo if interested.

CONVERSATION FLOW:

1. OPENING (casual, 30 seconds):
"Hey ${leadData?.name}! This is Kora from Boostly. You recently filled out our form about marketing for ${leadData?.company}. Got a quick minute to chat?"
[WAIT FOR FULL RESPONSE]

2. QUALIFY (confirm owner):
"Just to make sure I'm talking to the right person - you're the owner, right?"
[WAIT FOR FULL RESPONSE]
IF NOT OWNER: "Ah, I really need to chat with the owner about this. Could you have them give me a call when they're free?"

3. DISCOVERY (understand their needs):
Ask naturally in conversation and WAIT FOR COMPLETE ANSWERS:
- "How many customers you seeing weekly these days?" [PAUSE FOR ANSWER]
- "What percentage actually come back for a second visit?" [PAUSE FOR ANSWER]
- "What's your biggest headache with marketing right now?" [PAUSE FOR ANSWER]

4. VALUE PITCH (connect to their pain):
Based on what they say, mention:
- "We help restaurants get 600-800% ROI through automated SMS marketing"
- "Everything runs on autopilot - takes maybe 5 minutes a week"
- "Like Michael at Russo's - he gets $15 back for every dollar spent"

5. BOOKING THE DEMO:
When they show interest:
"Let me check what times we have available..."
[Use check_availability tool with when="tomorrow" or when="today"]
"I've got [time] or [time] open. What works better for you?"
[WAIT FOR THEIR CHOICE]

After they choose:
"Perfect, let me get that scheduled..."
[Use book_demo tool with all their information]
"All set! Jakob will give you a call at [time] to show you exactly how this works."

OBJECTION HANDLING:

"Too busy": 
"I totally get it - running a restaurant is non-stop. That's exactly why we built everything to run on autopilot. When's your slowest time for a quick 15-minute demo?"

"Too expensive":
"I hear you, margins are tight. But our average restaurant sees $10-15 back for every dollar. Want to see what your specific ROI could look like?"

"Already have marketing":
"Nice! What are you using? [LISTEN] Cool, we actually work great alongside that. Most folks keep what's working and add us for the SMS and review side."

IMPORTANT RULES:
- ALWAYS pause and wait for complete responses
- Don't interrupt or rush them
- Keep your responses to 2-3 sentences max
- Always book specific times, not "whenever works"
- Never quote specific prices - it's customized
- Website: Boostly.com

Remember: Be conversational and natural! Let them talk!`
                }
            };

            console.log('Sending session configuration to OpenAI...');
            openAiWs.send(JSON.stringify(sessionUpdate));
        };
        
        // OpenAI WebSocket opened - follow OpenAI's exact example
        openAiWs.on('open', function open() {
            console.log('Connected to OpenAI Realtime API');

            // Send session update immediately as per OpenAI docs
            sendSessionUpdate();
        });
        
        // Handle OpenAI responses - as per OpenAI docs
        openAiWs.on('message', function incoming(message) {
            try {
                const response = JSON.parse(message.toString());

                // Log message type for debugging
                console.log('OpenAI event:', response.type);

                // Log important message types
                if (response.type === 'session.created') {
                    console.log('✅ Session created');
                }
                if (response.type === 'session.updated') {
                    console.log('✅ Session updated successfully');

                    // Now trigger the AI to start speaking
                    const createResponse = {
                        type: 'response.create',
                        response: {
                            modalities: ['audio', 'text']
                        }
                    };
                    openAiWs.send(JSON.stringify(createResponse));
                    console.log('Triggered AI to start speaking');
                }
                if (response.type === 'response.created') {
                    console.log('🎤 AI starting to generate response');
                }
                if (response.type === 'response.audio.transcript.delta') {
                    console.log('📝 AI saying:', response.delta);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    if (!streamSid) {
                        console.log('⚠️ No stream ID yet, waiting...');
                        return;
                    }

                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: {
                            payload: response.delta
                        }
                    };

                    connection.send(JSON.stringify(audioDelta));

                    // Log more frequently during debugging
                    if (Math.random() < 0.1) {
                        console.log('📤 Sending audio to phone (streamSid:', streamSid, ')');
                    }
                }

                if (response.type === 'error') {
                    console.error('❌ OpenAI Error:', response.error);
                }
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });
        
        // Handle incoming audio from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                switch (data.event) {
                    case 'media':
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
                        console.log('Media format:', data.start.mediaFormat);
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
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Boostly AI SDR running on port ${PORT}`);
    console.log(`MCP Calendar endpoints available at /mcp/*`);
    console.log(`View booked demos at /demos`);
    console.log(`Slack notifications: ${SLACK_WEBHOOK_URL ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`${'='.repeat(60)}\n`);
});