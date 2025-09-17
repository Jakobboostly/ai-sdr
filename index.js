import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import twilio from 'twilio';

dotenv.config();

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SLACK_WEBHOOK_URL,
  ADMIN_PHONE,
  PORT = 5050
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- Fastify ----------
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, { origin: true, credentials: true });

const VOICE = 'alloy';

// In-memory state
const activeCallSessions = new Map();
const bookedDemos = new Map();

// ---------- Notifications ----------
async function sendSlackNotification(demoData) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const message = {
      text: "🎯 New Boostly Demo Booked!",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "🎯 New Demo Booked!" } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Restaurant:*\n${demoData.restaurantName}` },
            { type: "mrkdwn", text: `*Owner:*\n${demoData.ownerName}` },
            { type: "mrkdwn", text: `*Phone:*\n${demoData.phone}` },
            { type: "mrkdwn", text: `*Email:*\n${demoData.email || 'Not provided'}` },
            { type: "mrkdwn", text: `*Date/Time:*\n${demoData.datetime}` },
            { type: "mrkdwn", text: `*Rep:*\nJakob` }
          ]
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Notes:*\n${demoData.notes || 'No notes provided'}` }
        },
        { type: "divider" },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Booked by Kora AI at ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}` }
          ]
        }
      ]
    };
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message)
    });
    if (!res.ok) console.error('❌ Slack notification failed:', res.status, await res.text());
    else console.log('✅ Slack notification sent');
  } catch (e) { console.error('❌ Slack notify error:', e); }
}

async function sendSMS(demoData) {
  if (!ADMIN_PHONE) return;
  try {
    await twilioClient.messages.create({
      body: `New Demo: ${demoData.restaurantName} - ${demoData.ownerName} - ${demoData.datetime}`,
      from: TWILIO_PHONE_NUMBER,
      to: ADMIN_PHONE
    });
    console.log('✅ SMS notification sent');
  } catch (e) { console.error('❌ SMS error:', e); }
}

async function storeDemoData(demoData) {
  const demoId = `DEMO-${Date.now()}`;
  const fullDemo = { id: demoId, ...demoData, bookedAt: new Date().toISOString(), status: 'scheduled' };
  bookedDemos.set(demoId, fullDemo);
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

function generateCallId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Basic routes ----------
fastify.get('/', async (_req, reply) => reply.send({ message: 'Boostly AI SDR is running!' }));

fastify.get('/demos', async (_req, reply) => {
  const demos = Array.from(bookedDemos.values());
  reply.send({ count: demos.length, demos: demos.sort((a, b) => new Date(b.bookedAt) - new Date(a.bookedAt)) });
});

fastify.post('/make-call', async (request, reply) => {
  const { to, name, company, email } = request.body || {};
  if (!to || !name || !company) {
    return reply.status(400).send({ error: 'Required: phone number (to), name, and company' });
  }
  try {
    const callId = generateCallId();
    activeCallSessions.set(callId, { name, company, email: email || '', phoneNumber: to });

    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to,
      url: `https://${request.headers.host}/outbound-answer?callId=${callId}`,
      statusCallback: `https://${request.headers.host}/call-status?callId=${callId}`,
      statusCallbackEvent: ['queued', 'initiated', 'ringing', 'answered', 'completed', 'no-answer', 'busy', 'failed'],
      machineDetection: 'DetectMessageEnd',
      asyncAmd: true,
      timeout: 30
    });

    reply.send({ success: true, callSid: call.sid, message: `Calling ${name} at ${company}...` });
  } catch (err) {
    console.error('Error making call:', err);
    reply.status(500).send({ error: 'Failed to initiate call: ' + err.message });
  }
});

fastify.all('/outbound-answer', async (request, reply) => {
  const callId = request.query.callId;
  // Pass callId via <Parameter> so Twilio includes it in WS "start"
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream">
      <Parameter name="callId" value="${callId}" />
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});

fastify.post('/call-status', async (request, reply) => {
  const { CallStatus, CallDuration, To } = request.body || {};
  const callId = request.query.callId;
  const leadData = activeCallSessions.get(callId);
  console.log(`Call to ${leadData?.name} (${To}): ${CallStatus}`);
  if (['completed', 'no-answer', 'busy', 'failed'].includes(CallStatus)) {
    console.log(`Call Result - Name: ${leadData?.name}, Company: ${leadData?.company}, Status: ${CallStatus}, Duration: ${CallDuration || 0}s`);
    setTimeout(() => activeCallSessions.delete(callId), 60_000);
  }
  reply.send({ received: true });
});

// ---------- MCP demo endpoints ----------
const DEMO_SLOTS = {
  monday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
  tuesday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
  wednesday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
  thursday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"],
  friday: ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM"]
};

fastify.post('/mcp/list_tools', async () => ({
  tools: [
    {
      name: "check_availability",
      description: "Check available demo slots for a specific date",
      parameters: {
        type: "object",
        properties: { when: { type: "string", description: "Date to check: 'today', 'tomorrow', or day name" } },
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
}));

fastify.post('/mcp/call_tool', async (request) => {
  const { tool, arguments: args } = request.body || {};
  if (tool === 'check_availability') {
    let targetDate = new Date();

    if (args.when === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
    else if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes((args.when || '').toLowerCase())) {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(args.when.toLowerCase());
      const currentDay = targetDate.getDay();
      const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
      targetDate.setDate(targetDate.getDate() + daysUntilTarget);
    }

    const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(targetDate).toLowerCase();
    const dateStr = targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    if (dayName === 'saturday' || dayName === 'sunday') {
      return { success: true, message: "No demos on weekends", slots: [] };
    }

    const allSlots = DEMO_SLOTS[dayName] || [];
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
      slots: available.map(time => ({ time, display: `${dateStr} at ${time}` }))
    };
  }

  if (tool === 'book_demo') {
    const demoId = await storeDemoData(args);
    await sendSlackNotification(args);
    await sendSMS(args);
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

// ---------- Twilio <-> OpenAI bridge ----------
fastify.register(async (instance) => {
  instance.get('/media-stream', { websocket: true }, (connection, req) => {
    const ws = connection.socket; // raw ws

    // Connect to OpenAI Realtime
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    let streamSid = null;
    let callId = null;
    let leadData = null;

    // Commit gating
    const FRAME_MS = 20;                // Twilio frame ≈20ms at 8kHz
    let framesSinceCommit = 0;          // frames appended since last commit
    let haveUncommittedAudio = false;   // whether anything appended since last commit

    // Response gating
    let responseInFlight = false;

    // Buffer model audio until streamSid known
    const pendingModelAudio = [];
    let oaOpen = false;
    let kickoffPending = false;

    const sendSessionUpdate = () => {
      if (!oaOpen) return;
      const instructions = `You are Kora, Boostly's friendly marketing consultant. You're calling ${leadData?.name} from ${leadData?.company} who recently filled out a form on Facebook about restaurant marketing.

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

1. OPENING:
"Hey ${leadData?.name}! This is Kora from Boostly. You recently filled out our form about marketing for ${leadData?.company}. Got a quick minute to chat?"
[WAIT FOR FULL RESPONSE]

2. QUALIFY:
"Just to make sure I'm talking to the right person - you're the owner, right?"
[WAIT FOR FULL RESPONSE]
IF NOT OWNER: "Ah, I really need to chat with the owner about this. Could you have them give me a call when they're free?"

3. DISCOVERY (ask, then pause for full answers):
- "How many customers you seeing weekly these days?"
- "What percentage actually come back for a second visit?"
- "What's your biggest headache with marketing right now?"

4. VALUE PITCH (tailored):
- "We help restaurants get 600-800% ROI through automated SMS marketing"
- "Everything runs on autopilot - takes maybe 5 minutes a week"
- "Like Michael at Russo's - he gets $15 back for every dollar spent"

5. BOOKING THE DEMO:
When they show interest:
"Let me check what times we have available..."
[Use check_availability tool with when="tomorrow" or when="today"]
"I've got [time] or [time] open. What works better for you?"
[WAIT FOR CHOICE]
Then:
"Perfect, let me get that scheduled..."
[Use book_demo tool]
"All set! Jakob will give you a call at [time] to show you exactly how this works."

OBJECTION HANDLING:
- "Too busy": emphasize autopilot; ask for slowest time for a 15-min demo
- "Too expensive": emphasize ROI ($10-15 per $1 typical)
- "Already have marketing": ask what; explain complementarity (SMS + reviews)

RULES:
- Pause and let them finish
- Keep replies 2–3 sentences
- Offer specific times (not "whenever")
- No pricing specifics; it's customized
- Website: Boostly.com`;

      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          voice: VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          temperature: 0.8,
          instructions
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const kickoffConversation = () => {
      if (!oaOpen || !streamSid) { kickoffPending = true; return; }
      // Start the first response once Twilio stream is ready
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Start the conversation with a friendly greeting.' }] }
      }));
      if (!responseInFlight) {
        responseInFlight = true;
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
      }
    };

    // ---- OpenAI events ----
    openAiWs.on('open', () => {
      oaOpen = true;
      console.log('Connected to the OpenAI Realtime API');
      if (kickoffPending) {
        sendSessionUpdate();
        kickoffConversation();
        kickoffPending = false;
      }
    });

    openAiWs.on('message', (msg) => {
      let response;
      try { response = JSON.parse(msg); } catch { return; }

      // Mark response in-flight bookkeeping
      if (response.type === 'response.created') responseInFlight = true;
      if (response.type === 'response.done') responseInFlight = false;

      // Log tersely
      if (!['response.audio.delta', 'response.output_audio.delta'].includes(response.type)) {
        console.log('OpenAI event:', response.type);
      }

      // Forward model audio to Twilio
      if ((response.type === 'response.audio.delta' || response.type === 'response.output_audio.delta') && response.delta) {
        if (!streamSid) {
          pendingModelAudio.push(response.delta);
          // do not log every time; noisy
        } else {
          const audioDelta = { event: 'media', streamSid, media: { payload: response.delta } };
          try { ws.send(JSON.stringify(audioDelta)); } catch (e) { console.error('Send to Twilio failed:', e); }
        }
      }

      // When VAD indicates user stopped, only create a response if none active
      if (response.type === 'input_audio_buffer.speech_stopped') {
        if (haveUncommittedAudio) {
          openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          haveUncommittedAudio = false;
          framesSinceCommit = 0;
        }
        if (!responseInFlight) {
          responseInFlight = true;
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }
      }

      if (response.type === 'error') {
        console.error('❌ OpenAI Error:', response.error || response);
      }
    });

    openAiWs.on('close', () => console.log('Disconnected from OpenAI'));
    openAiWs.on('error', (err) => console.error('OpenAI WebSocket error:', err));

    // Keepalive OpenAI
    const oaPing = setInterval(() => {
      try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.ping(); } catch {}
    }, 20_000);

    // ---- Twilio events (raw socket) ----
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.event) {
        case 'start': {
          streamSid = data.start?.streamSid;

          // Prefer customParameters
          const params = data.start?.customParameters || {};
          callId = params.callId || callId;

          // Fallback: parse query if present
          if (!callId) {
            try {
              const urlObj = new URL(`wss://x${req.url}`);
              callId = urlObj.searchParams.get('callId');
            } catch {}
          }

          leadData = activeCallSessions.get(callId);
          console.log('Twilio stream started. streamSid:', streamSid, 'callId:', callId, 'lead:', leadData);

          if (oaOpen) {
            sendSessionUpdate();
            kickoffConversation();
          } else {
            kickoffPending = true;
          }

          // Flush buffered model audio (if any)
          if (pendingModelAudio.length) {
            for (const delta of pendingModelAudio) {
              try { ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: delta } })); }
              catch (e) { console.error('Send buffered frame failed:', e); }
            }
            pendingModelAudio.length = 0;
          }
          break;
        }

        case 'media': {
          // Append inbound μ-law audio (base64) to the model
          const payload = data.media?.payload;
          if (openAiWs.readyState === WebSocket.OPEN && payload) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
            framesSinceCommit += 1;
            haveUncommittedAudio = true;

            // Commit only when we have at least ~100ms
            if (framesSinceCommit * FRAME_MS >= 120) { // 6 frames ≈120ms
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              framesSinceCommit = 0;
              haveUncommittedAudio = false;
            }
          }
          break;
        }

        case 'stop': {
          // Finalize audio if any was appended since the last commit
          if (openAiWs.readyState === WebSocket.OPEN && haveUncommittedAudio) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            framesSinceCommit = 0;
            haveUncommittedAudio = false;
          }
          // Ask for a response only if none is active
          if (openAiWs.readyState === WebSocket.OPEN && !responseInFlight) {
            responseInFlight = true;
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
          }
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      clearInterval(oaPing);
      try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
      console.log(`Call ${callId || ''} ended`);
    });

    ws.on('error', (e) => console.error('Twilio WS error:', e));

    // Keepalive Twilio
    const twilioPing = setInterval(() => {
      try { ws.ping(); } catch {}
    }, 25_000);
    ws.on('close', () => clearInterval(twilioPing));
  });
});

// ---------- Start server ----------
fastify.listen({ port: Number(PORT), host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Boostly AI SDR running at ${address}`);
  console.log(`MCP Calendar endpoints available at /mcp/*`);
  console.log(`View booked demos at /demos`);
  console.log(`Slack notifications: ${SLACK_WEBHOOK_URL ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`${'='.repeat(60)}\n`);
});
