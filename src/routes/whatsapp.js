const express = require('express');
const { MessagingResponse } = require('twilio').twiml;

const { processMessage } = require('../services/agentCore');

const router = express.Router();

router.post('/webhook', async (req, res) => {
  const from = req.body.From; // e.g. "whatsapp:+2348012345678"
  const body = req.body.Body || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0 || '';

  const twiml = new MessagingResponse();

  try {
    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const result = await processMessage({
      identity: from,
      body,
      channel: 'whatsapp',
      baseUrl,
      mediaUrl,
      mediaType,
      twilioAuth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
    });

    const fullText = result.dashboardLink
      ? `${result.text}\n\nOpen your dashboard here, it logs you in automatically: ${result.dashboardLink}`
      : result.text;

    twiml.message(fullText);
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('Something went wrong on my end. Please try again in a moment.');
    return res.type('text/xml').send(twiml.toString());
  }
});

module.exports = router;
