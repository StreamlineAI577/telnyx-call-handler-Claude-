const express = require('express');
const app = express();
app.use(express.json());

// Map each Telnyx number to its client info
const clientMap = {
  '+19714356058': {
    clientId: 'client_001',
    businessName: 'StreamlineAI',
    businessPhone: '+19717626038',
    aiContext: 'You are a helpful assistant for StreamlineAI.'
  }
};

// Track active calls in memory while they're happening
const activeCalls = {};

// Helper: send a request to the Telnyx API
async function telnyx(path, body) {
  const res = await fetch(`https://api.telnyx.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Telnyx ${path} failed:`, JSON.stringify(data));
  }
  return data;
}

// Helper: send the missed-call text-back to the caller
async function sendMissedCallText(client, callerNumber, telnyxNumber, reason) {
  console.log(`Sending missed-call text to ${callerNumber} (reason: ${reason})`);
  await telnyx('/v2/messages', {
    from: telnyxNumber,
    to: callerNumber,
    text: `Hi, this is ${client.businessName}. Sorry we missed your call — how can we help?`
  });
}

app.post('/call', async (req, res) => {
  // Always reply to Telnyx fast so it doesn't retry
  res.sendStatus(200);

  const eventType = req.body?.data?.event_type;
  const payload = req.body?.data?.payload;
  if (!payload) return;

  const callControlId = payload.call_control_id;
  const direction = payload.direction;
  const calledNumber = payload.to;
  const callerNumber = payload.from;

  console.log(`Event: ${eventType} | direction: ${direction} | leg: ${callControlId}`);

  // ============================================================
  // STEP 1: Inbound call arrives — answer it so we have control
  // ============================================================
  if (eventType === 'call.initiated' && direction === 'incoming') {
    const client = clientMap[calledNumber];
    if (!client) {
      console.log('No client mapped for number:', calledNumber);
      return;
    }

    // Save this call's info so later events can find it
    activeCalls[callControlId] = {
      role: 'inbound',
      client,
      callerNumber,
      telnyxNumber: calledNumber,
      humanAnswered: false,
      textSent: false,
      outboundLegId: null
    };

    console.log(`Incoming call for ${client.businessName} from ${callerNumber} — answering`);
    await telnyx(`/v2/calls/${callControlId}/actions/answer`, {});
    return;
  }

  // ============================================================
  // STEP 2: Inbound leg is answered — now dial the client's phone
  // ============================================================
  if (eventType === 'call.answered') {
    const callData = activeCalls[callControlId];

    // This is the inbound leg getting answered by us
    if (callData && callData.role === 'inbound' && !callData.outboundLegId) {
      const { client, callerNumber, telnyxNumber } = callData;
      console.log(`Inbound answered. Dialing ${client.businessPhone} with AMD on.`);

      const dialResult = await telnyx('/v2/calls', {
        connection_id: payload.connection_id,
        to: client.businessPhone,
        from: telnyxNumber,
        from_display_name: callerNumber, // show original caller ID if carrier allows
        timeout_secs: 45, // long enough for client's voicemail to pick up
        answering_machine_detection: 'premium',
        // Tag this outbound leg so we know which inbound it belongs to
        client_state: Buffer.from(JSON.stringify({
          parentLegId: callControlId
        })).toString('base64')
      });

      const outboundLegId = dialResult?.data?.call_control_id;
      if (outboundLegId) {
        callData.outboundLegId = outboundLegId;
        // Register the outbound leg so its events can find the parent
        activeCalls[outboundLegId] = {
          role: 'outbound',
          parentLegId: callControlId
        };
      }
      return;
    }

    // This is the outbound leg getting answered (by something — could be human OR voicemail)
    if (callData && callData.role === 'outbound') {
      const parent = activeCalls[callData.parentLegId];
      if (!parent) return;

      console.log(`Outbound leg answered. Waiting for AMD result before bridging.`);
      // Don't bridge yet — wait for AMD to tell us if it's a human or machine
      return;
    }
  }

  // ============================================================
  // STEP 3: AMD result — human or machine?
  // ============================================================
  if (eventType === 'call.machine.premium.detection.ended') {
    const callData = activeCalls[callControlId];
    if (!callData || callData.role !== 'outbound') return;

    const parent = activeCalls[callData.parentLegId];
    if (!parent) return;

    const result = payload.result; // 'human_residence', 'human_business', 'machine', 'silence', 'fax', 'unknown'
    console.log(`AMD result: ${result}`);

    const isHuman = result === 'human_residence' || result === 'human_business';

    if (isHuman) {
      // HUMAN ANSWERED — bridge the two legs together
      parent.humanAnswered = true;
      console.log('Human detected. Bridging caller to client.');
      await telnyx(`/v2/calls/${callControlId}/actions/bridge`, {
        call_control_id: parent.callerLegId || callData.parentLegId
      });
    } else {
      // MACHINE / VOICEMAIL — bridge so the caller can leave a voicemail like normal
      console.log('Voicemail detected. Bridging so caller can leave a message.');
      await telnyx(`/v2/calls/${callControlId}/actions/bridge`, {
        call_control_id: callData.parentLegId
      });

      // Send the missed-call text now (don't wait for hangup)
      if (!parent.textSent) {
        parent.textSent = true;
        await sendMissedCallText(
          parent.client,
          parent.callerNumber,
          parent.telnyxNumber,
          'voicemail'
        );
      }
    }
    return;
  }

  // ============================================================
  // STEP 4: A leg hangs up
  // ============================================================
  if (eventType === 'call.hangup') {
    const callData = activeCalls[callControlId];
    if (!callData) return;

    // Outbound leg hung up
    if (callData.role === 'outbound') {
      const parent = activeCalls[callData.parentLegId];
      const hangupCause = payload.hangup_cause;
      console.log(`Outbound leg hung up. cause: ${hangupCause}`);

      if (parent && !parent.humanAnswered && !parent.textSent) {
        // No human ever answered — this is a missed call. Send the text.
        parent.textSent = true;
        await sendMissedCallText(
          parent.client,
          parent.callerNumber,
          parent.telnyxNumber,
          `outbound_hangup_${hangupCause}`
        );
        // Hang up the inbound leg too so the caller isn't left hanging
        await telnyx(`/v2/calls/${callData.parentLegId}/actions/hangup`, {});
      }

      delete activeCalls[callControlId];
      return;
    }

    // Inbound leg hung up
    if (callData.role === 'inbound') {
      // If the caller hung up before anything resolved, still send a text
      if (!callData.humanAnswered && !callData.textSent) {
        callData.textSent = true;
        await sendMissedCallText(
          callData.client,
          callData.callerNumber,
          callData.telnyxNumber,
          'caller_hung_up'
        );
      }

      // Clean up the outbound leg if it's still tracked
      if (callData.outboundLegId) {
        delete activeCalls[callData.outboundLegId];
      }
      delete activeCalls[callControlId];
      return;
    }
  }
});

// Inbound SMS endpoint
app.post('/sms', async (req, res) => {
  res.sendStatus(200);
  const payload = req.body?.data?.payload;
  console.log('Inbound SMS:', JSON.stringify(payload));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
